/**
 * exporter.js — 导出接线(模块 C,契约见 INTERFACE.md 第 4 节)
 *
 * 真正的格式实现在模块 A 的 lib/exporters.mjs;这里负责:格式清单、文件名、浏览器内下载。
 * 同样用动态 import:lib 未就绪时不影响界面启动,导出时才报可读错误。
 */

const EXPORTER_URL = '../../lib/exporters.mjs';

let core = null;
let coreError = null;
let corePromise = null;

/**
 * 模块 A 的 exporters 缺失时,至少让下拉菜单有格式可选。
 * id 必须与 lib/exporters.mjs 的 EXPORTERS 键完全一致 —— 否则这条兜底路径
 * 交给 buildExport() 时会找不到实现,而它只在 lib 加载失败时才会被用到,
 * 属于"平时看不见、出事时必现"的那类坑。
 */
export const FALLBACK_FORMATS = [
  { id: 'srt', label: 'SRT 字幕', ext: '.srt' },
  { id: 'vtt', label: 'WebVTT 字幕', ext: '.vtt' },
  { id: 'lrc', label: 'LRC 歌词', ext: '.lrc' },
  { id: 'enhanced-lrc', label: '增强 LRC(逐字)', ext: '.lrc' },
  { id: 'ass', label: 'ASS 卡拉OK', ext: '.ass' },
];

export async function ensureExporterCore() {
  if (core) return core;
  if (!corePromise) {
    corePromise = import(EXPORTER_URL)
      .then((mod) => {
        core = mod;
        coreError = null;
        return mod;
      })
      .catch((err) => {
        coreError = err;
        corePromise = null;
        throw err;
      });
  }
  return corePromise;
}

export function exporterStatus() {
  return { ready: !!core, error: coreError ? String(coreError.message || coreError) : null };
}

function entryFor(format) {
  const table = core && core.EXPORTERS;
  if (!table) return null;
  if (table[format] && typeof table[format].fn === 'function') return table[format];
  const key = String(format || '').toLowerCase();
  for (const [id, entry] of Object.entries(table)) {
    if (!entry || typeof entry.fn !== 'function') continue;
    if (id.toLowerCase() === key) return entry;
    if (String(entry.ext || '').replace(/^\./, '').toLowerCase() === key) return entry;
  }
  return null;
}

/** 从 lib/exporters.mjs 的 EXPORTERS 生成 */
export function exportFormats() {
  const table = core && core.EXPORTERS;
  if (!table || typeof table !== 'object') return FALLBACK_FORMATS.map((f) => ({ ...f }));
  return Object.entries(table)
    .filter(([, e]) => e && typeof e.fn === 'function')
    .map(([id, e]) => ({
      id,
      label: e.label || String(id).toUpperCase(),
      ext: e.ext || `.${id}`,
      mime: e.mime || 'text/plain;charset=utf-8',
    }));
}

export function safeFileName(name, ext) {
  const base = String(name || 'subtitle')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
  return `${base || 'subtitle'}${ext || '.txt'}`;
}

/**
 * buildExport(format, project, opts) → { text, filename, mime }
 * opts 透传给模块 A:{ includeHidden?, includeMeta?, title? }
 */
export function buildExport(format, project, opts = {}) {
  if (!project) throw new Error('没有可导出的项目');
  const entry = entryFor(format);
  if (!entry) {
    if (coreError) throw new Error(`导出模块(lib/exporters.mjs)加载失败:${coreError.message || coreError}`);
    throw new Error(`不支持的导出格式:${format}(导出模块可能尚未就绪)`);
  }
  const tracks = Array.isArray(project.tracks) ? project.tracks : [];
  const text = entry.fn(tracks, { title: project.name, ...opts });
  return {
    text: String(text ?? ''),
    filename: safeFileName(project.name, entry.ext || `.${format}`),
    mime: entry.mime || 'text/plain;charset=utf-8',
    format,
  };
}

/** Blob + a[download],纯浏览器内触发下载(静态部署也能用) */
export function download(text, filename, mime = 'text/plain;charset=utf-8') {
  if (typeof document === 'undefined' || typeof URL === 'undefined' || typeof Blob === 'undefined') {
    throw new Error('当前环境不支持浏览器下载');
  }
  const blob = new Blob([String(text ?? '')], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    try {
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      /* 忽略 */
    }
  }, 1000);
  return filename;
}

/** 一键:生成 + 下载 */
export function exportAndDownload(format, project, opts) {
  const built = buildExport(format, project, opts);
  download(built.text, built.filename, built.mime);
  return built;
}
