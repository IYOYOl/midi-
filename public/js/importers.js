/**
 * importers.js — MIDI 读取 + 项目构建(模块 C,契约见 INTERFACE.md 第 4 节)
 *
 * 调模块 A 的 lib/midi.mjs / lib/segments.mjs / lib/project.mjs。
 * 这里用 **动态 import**:lib 尚未就绪时页面不会整页白屏,界面照常可开,
 * 导入时才给出可读的中文原因(ui.js 会把它显示出来)。
 */

export const SETTINGS_DEFAULTS = {
  gapMs: 600,
  breakChars: '。!?…—、,.！？',
  minDurationMs: 200,
};

const CORE_URLS = {
  midi: '../../lib/midi.mjs',
  segments: '../../lib/segments.mjs',
  project: '../../lib/project.mjs',
};

let core = null;
let coreError = null;
let corePromise = null;

/** 预加载模块 A(ui.js 启动时调用);失败会 reject,调用方需 catch */
export async function ensureCore() {
  if (core) return core;
  if (!corePromise) {
    corePromise = (async () => {
      const [midi, segments, project] = await Promise.all([
        import(CORE_URLS.midi),
        import(CORE_URLS.segments),
        import(CORE_URLS.project),
      ]);
      core = { midi, segments, project };
      coreError = null;
      return core;
    })().catch((err) => {
      coreError = err;
      corePromise = null; // 允许稍后重试
      throw err;
    });
  }
  return corePromise;
}

/** 模块 A 是否就绪:{ ready, error } */
export function coreStatus() {
  return {
    ready: !!core,
    error: coreError ? String(coreError.message || coreError) : null,
  };
}

function requireCore() {
  if (core) return core;
  if (coreError) {
    throw new Error(
      `核心算法模块(lib/)加载失败:${coreError.message || coreError}。若在静态部署下访问,请确认 lib/ 与 public/ 一起发布。`,
    );
  }
  throw new Error('核心算法模块(lib/)尚未就绪,请稍后重试(模块 A 仍在加载或缺失)');
}

/* ------------------------------------------------------------------ *
 * 读文件
 * ------------------------------------------------------------------ */

/** File → { buf: Uint8Array, name: string } */
export async function readMidiFile(file) {
  if (!file) throw new Error('没有选择 MIDI 文件');
  const name = file.name || 'untitled.mid';
  if (typeof file.arrayBuffer === 'function') {
    const ab = await file.arrayBuffer();
    return { buf: new Uint8Array(ab), name };
  }
  const buf = await new Promise((resolve, reject) => {
    try {
      const fr = new FileReader();
      fr.onload = () => resolve(new Uint8Array(fr.result));
      fr.onerror = () => reject(new Error(`读取文件失败:${name}`));
      fr.readAsArrayBuffer(file);
    } catch (err) {
      reject(new Error(`读取文件失败:${name}(${err && err.message ? err.message : err})`));
    }
  });
  return { buf, name };
}

/* ------------------------------------------------------------------ *
 * 兜底项目(模块 A 尚未就绪时,界面依然能建项目、改时间、刷新恢复)
 * ------------------------------------------------------------------ */

export function stripExt(fileName) {
  return String(fileName || '未命名').replace(/\.[^.]+$/, '') || '未命名';
}

export function fallbackEmptyProject(name = '未命名项目') {
  return {
    id: null,
    name,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    durationMs: 0,
    midi: null,
    tracks: [{ id: 't_1', name: 'Track 1', visible: true, locked: false, segments: [] }],
    settings: { ...SETTINGS_DEFAULTS },
    revision: 0,
  };
}

/* ------------------------------------------------------------------ *
 * MidiData → Project
 * ------------------------------------------------------------------ */

function mkSegment(index, startMs, endMs, text, source) {
  const start = Math.max(0, Math.round(Number(startMs) || 0));
  const end = Math.round(Number(endMs) || 0) > start ? Math.round(Number(endMs)) : start + 200;
  return { id: `s_${index}`, startMs: start, endMs: end, text: String(text ?? ''), kind: 'lyric', source: source || null, words: null };
}

/** 兜底:模块 A 的 createProject 不可用/没建出片段时,自己按 MIDI 歌词铺一遍 */
function tracksFromMidiData(midiData, settings, segmentsApi) {
  const tracks = [];
  const list = Array.isArray(midiData && midiData.tracks) ? midiData.tracks : [];
  list.forEach((t, i) => {
    const lyrics = Array.isArray(t.lyrics) ? t.lyrics : [];
    if (!lyrics.length) return;
    const events = lyrics.map((l) => ({ tick: l.tick, ms: l.ms, text: l.text, trackIndex: t.index ?? i + 1 }));
    let segs = [];
    try {
      segs = typeof segmentsApi.buildSegments === 'function' ? segmentsApi.buildSegments(events, settings) : [];
    } catch {
      segs = [];
    }
    if (!Array.isArray(segs) || !segs.length) {
      // 再兜一层:一个音一个片段,保证导入后有东西可编辑
      segs = events.map((e, k) => mkSegment(k + 1, e.ms, e.ms + (settings.minDurationMs || 200), e.text, { trackIndex: e.trackIndex, tick: e.tick }));
    }
    tracks.push({
      id: `t_${i + 1}`,
      name: t.name || `Track ${i + 1}`,
      visible: true,
      locked: false,
      segments: segs,
    });
  });
  return tracks;
}

function ensureProjectShape(project, fileName, midiData, settings, p) {
  const out = project && typeof project === 'object' ? project : fallbackEmptyProject(stripExt(fileName));
  if (!Array.isArray(out.tracks)) out.tracks = [];
  if (!out.settings || typeof out.settings !== 'object') out.settings = { ...settings };
  if (!out.name) out.name = stripExt(fileName);
  out.midi = {
    fileName: fileName || out.midi?.fileName || '',
    // 服务端没建 ppq/format 字段时补齐
    ...(out.midi && typeof out.midi === 'object' ? out.midi : {}),
    ppq: (midiData && midiData.ppq) ?? out.midi?.ppq ?? null,
    format: (midiData && midiData.format) ?? out.midi?.format ?? null,
    tempoCount: Array.isArray(midiData && midiData.tempos) ? midiData.tempos.length : out.midi?.tempoCount ?? 0,
    importedAt: Date.now(),
  };
  // 只保留有歌词的轨(MIDI 里常见空轨)
  out.tracks = out.tracks.filter((t) => t && Array.isArray(t.segments) && t.segments.length);
  if (!out.tracks.length) {
    const tracks = tracksFromMidiData(midiData, out.settings, (p && p.segments) || {});
    out.tracks = tracks;
  }
  if (typeof p?.recomputeDuration === 'function') {
    const d = Number(p.recomputeDuration(out));
    if (Number.isFinite(d) && d > 0) out.durationMs = d;
  }
  if (!Number.isFinite(Number(out.durationMs)) || Number(out.durationMs) <= 0) {
    let max = 0;
    for (const t of out.tracks) for (const s of t.segments) max = Math.max(max, Number(s.endMs) || 0);
    out.durationMs = max;
  }
  return out;
}

/**
 * buf + 文件名 → Project(同步,契约见第 4 节)。
 * 需要先 await ensureCore();未就绪时抛可读中文错误。
 */
export function midiToProject(buf, fileName, settings) {
  const p = requireCore();
  if (!buf || typeof buf.length !== 'number' || !buf.length) throw new Error('MIDI 内容为空');
  const merged = { ...SETTINGS_DEFAULTS, ...(settings || {}) };
  const midiData = p.midi.parseMidi(buf); // 解析失败会抛带中文原因的 Error
  let project = null;
  if (typeof p.project?.createProject === 'function') {
    try {
      project = p.project.createProject({ name: stripExt(fileName), midiData, fileName, settings: merged });
    } catch (err) {
      project = null;
      // createProject 内部出错时退回自己的兜底拼装,不让用户白导入一次
      if (typeof console !== 'undefined') console.warn('[importers] createProject 失败,使用兜底拼装:', err);
    }
  }
  const shaped = ensureProjectShape(project, fileName, midiData, merged, p.project);
  const projectApi = p.project;
  if (projectApi && typeof projectApi.normalizeProject === 'function') {
    try {
      return projectApi.normalizeProject(shaped);
    } catch {
      return shaped;
    }
  }
  return shaped;
}

/** 新建空项目:模块 A 的 emptyProject 优先,缺失时用兜底 */
export function newProjectObject(name = '未命名项目', settings) {
  const merged = { ...SETTINGS_DEFAULTS, ...(settings || {}) };
  let project = null;
  if (core && typeof core.project?.emptyProject === 'function') {
    try {
      project = core.project.emptyProject(name);
    } catch {
      project = null;
    }
  }
  if (!project) project = fallbackEmptyProject(name);
  if (!Array.isArray(project.tracks) || !project.tracks.length) {
    project.tracks = [{ id: 't_1', name: 'Track 1', visible: true, locked: false, segments: [] }];
  }
  if (!project.settings || typeof project.settings !== 'object') project.settings = merged;
  project.id = project.id || null;
  project.revision = Number.isFinite(Number(project.revision)) ? Number(project.revision) : 0;
  return project;
}
