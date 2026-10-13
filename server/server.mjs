#!/usr/bin/env node
// server/server.mjs — 单端口同时伺服静态文件与 REST API(零 npm 依赖)
//
// 路由表(INTERFACE.md 第 5 节,冻结契约):
//   GET    /api/health                      -> { ok:true, kind:'server', version }
//   GET    /api/projects                    -> [{ id, name, updatedAt, revision }]
//   POST   /api/projects                    -> 收 Project,分配 id,落盘,返回带 revision:1
//   GET    /api/projects/:id                -> 完整 Project
//   PUT    /api/projects/:id                -> 收 { project, baseRevision? },revision+1
//   PATCH  /api/projects/:id                -> { name } 重命名
//   DELETE /api/projects/:id                -> 删除
//   GET    /api/projects/:id/history        -> [{ revision, savedAt, bytes }]
//   POST   /api/projects/:id/restore        -> { revision } 用快照覆盖并 +1
//   GET    /api/projects/:id/export/:format -> 直接返回字幕文本(Content-Disposition: attachment)
// 未知 /api 路径一律 404 JSON(绝不回 HTML)。
//
// 静态根默认是**仓库根**(public/index.html 里要 import `../lib/*.mjs`),
// 但 server/、tests/、node_modules/ 以及数据目录永远不可访问(见 DENY_*)。

import http from 'node:http';
import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  createStore,
  isSafeId,
  RevisionConflictError,
  NotFoundError,
  AlreadyExistsError,
  StoreError,
} from './store.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** 仓库根:lib/ 在这里(注意 --root 只影响静态伺服,不影响 lib 的位置) */
export const REPO_ROOT = path.resolve(HERE, '..');
const VERSION = '1.0.0';
const DEFAULT_PORT = 4517;
const MAX_BODY_BYTES = 64 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Content-Type:`.mjs` 必须是 text/javascript,否则浏览器拒绝加载 ES module(整页白屏)
// ---------------------------------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
  '.mid': 'audio/midi',
  '.midi': 'audio/midi',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.flac': 'audio/flac',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
};

function mimeOf(filePath) {
  return MIME[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

// ---------------------------------------------------------------------------
// CORS(方便从别的端口/IDE 预览里探测 /api/health,不影响同源部署)
// ---------------------------------------------------------------------------
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '600',
};

// ---------------------------------------------------------------------------
// 静态访问黑名单
// ---------------------------------------------------------------------------
/** 按名字拒绝的顶层目录(即使静态根被 --root 换掉也生效) */
const DENY_TOP_DIRS = new Set(['server', 'tests', 'node_modules']);

/** child 是否位于 parent 之内(或就是它) */
function isInsideOrEqual(parent, child) {
  const rel = path.relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

// ---------------------------------------------------------------------------
// 请求 / 响应小工具
// ---------------------------------------------------------------------------
function corsHeaders(extra = {}) {
  return { ...CORS_HEADERS, ...extra };
}

function sendJson(req, res, status, payload, extraHeaders = {}) {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const body = Buffer.from(`${JSON.stringify(payload)}\n`, 'utf8');
  res.writeHead(
    status,
    corsHeaders({
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': body.length,
      'Cache-Control': 'no-store',
      ...extraHeaders,
    }),
  );
  if (req.method === 'HEAD') res.end();
  else res.end(body);
}

function sendText(req, res, status, text, headers = {}) {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const body = Buffer.from(text, 'utf8');
  res.writeHead(
    status,
    corsHeaders({
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Length': body.length,
      'X-Content-Type-Options': 'nosniff',
      ...headers,
    }),
  );
  if (req.method === 'HEAD') res.end();
  else res.end(body);
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      const err = new Error(`request body larger than ${MAX_BODY_BYTES} bytes`);
      err.statusCode = 413;
      throw err;
    }
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.trim() === '') return {};
  try {
    return JSON.parse(text);
  } catch (err) {
    const e = new Error(`invalid JSON body: ${err.message}`);
    e.statusCode = 400;
    throw e;
  }
}

// ---------------------------------------------------------------------------
// lib/ 动态加载(模块 A 并行开发中:不存在也要能跑,存在了立刻自动接入)
// TODO(接入点):lib/project.mjs 的 normalizeProject 与 lib/exporters.mjs 就绪后
//   本文件无需改动即会自动使用它们;失败时才退化成内置校验 / 501。
// ---------------------------------------------------------------------------
const libCache = new Map(); // name -> { mod, error, at }

async function loadLib(name) {
  const cached = libCache.get(name);
  if (cached && cached.mod) return cached; // 只缓存成功
  if (cached && Date.now() - cached.at < 1000) return cached; // 失败后 1s 内不重复尝试
  const entry = { mod: null, error: null, at: Date.now() };
  try {
    entry.mod = await import(pathToFileURL(path.join(REPO_ROOT, 'lib', name)).href);
  } catch (err) {
    entry.error = err;
  }
  libCache.set(name, entry);
  return entry;
}

/** TODO(接入点):lib/project.mjs#normalizeProject 就绪后走真实实现 */
async function resolveNormalizeProject() {
  const { mod } = await loadLib('project.mjs');
  if (mod && typeof mod.normalizeProject === 'function') return mod.normalizeProject;
  return fallbackNormalizeProject;
}

async function normalizeProjectSafely(raw) {
  let fn;
  try {
    fn = await resolveNormalizeProject();
  } catch {
    fn = fallbackNormalizeProject;
  }
  try {
    const out = fn(raw);
    if (out && typeof out === 'object' && !Array.isArray(out)) return out;
  } catch (err) {
    console.warn('[server] normalizeProject threw, falling back:', err?.message ?? err);
  }
  return fallbackNormalizeProject(raw);
}

// ---------------------------------------------------------------------------
// 内置防御性校验(INTERFACE.md 第 1 节)。脏数据绝不许抛错。
// ---------------------------------------------------------------------------
const DEFAULT_SETTINGS = { gapMs: 600, breakChars: '。!?…—、,.！？', minDurationMs: 200 };
const DEFAULT_GAP_MS = 600;
const DEFAULT_MIN_DURATION_MS = 200;
const MIN_SEGMENT_MS = 200;

function toInt(value, fallback) {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? Math.round(n) : fallback;
}

function toNonNegInt(value, fallback) {
  return Math.max(0, toInt(value, fallback));
}

function normalizeSegment(raw, index) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const startMs = toNonNegInt(raw.startMs, 0);
  let endMs = toNonNegInt(raw.endMs, startMs + MIN_SEGMENT_MS);
  // 约定:endMs > startMs 恒成立,缺了先补齐(默认 +200ms)
  if (endMs <= startMs) endMs = startMs + MIN_SEGMENT_MS;
  let source = null;
  if (raw.source && typeof raw.source === 'object' && !Array.isArray(raw.source)) {
    source = {
      trackIndex: toNonNegInt(raw.source.trackIndex, 0),
      tick: toNonNegInt(raw.source.tick, 0),
    };
  }
  let words = null;
  if (Array.isArray(raw.words)) {
    words = raw.words
      .filter((w) => w && typeof w === 'object')
      .map((w) => ({
        text: typeof w.text === 'string' ? w.text : String(w.text ?? ''),
        startMs: toNonNegInt(w.startMs, 0),
        endMs: toNonNegInt(w.endMs, 0),
      }));
  }
  return {
    id: typeof raw.id === 'string' && raw.id !== '' ? raw.id : `s_${index + 1}`,
    startMs,
    endMs,
    text: typeof raw.text === 'string' ? raw.text : String(raw.text ?? ''),
    kind: raw.kind === 'meta' ? 'meta' : 'lyric',
    source,
    words,
  };
}

function normalizeTrack(raw, index) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const segments = (Array.isArray(raw.segments) ? raw.segments : [])
    .map((s, i) => normalizeSegment(s, i))
    .filter(Boolean);
  // 升序、不重叠、endMs > startMs
  segments.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  const seen = new Set();
  let prevEnd = 0;
  for (const seg of segments) {
    if (seg.startMs < prevEnd) seg.startMs = prevEnd;
    if (seg.endMs <= seg.startMs) seg.endMs = seg.startMs + MIN_SEGMENT_MS;
    prevEnd = seg.endMs;
    let id = seg.id;
    let n = 1;
    while (seen.has(id)) id = `${seg.id}_${n++}`;
    seg.id = id;
    seen.add(id);
  }
  return {
    id: typeof raw.id === 'string' && raw.id !== '' ? raw.id : `t_${index + 1}`,
    name: typeof raw.name === 'string' && raw.name !== '' ? raw.name : `Track ${index + 1}`,
    visible: raw.visible !== false,
    locked: raw.locked === true,
    segments,
  };
}

function normalizeSettings(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    gapMs: toNonNegInt(src.gapMs, DEFAULT_GAP_MS),
    breakChars: typeof src.breakChars === 'string' ? src.breakChars : DEFAULT_SETTINGS.breakChars,
    minDurationMs: toNonNegInt(src.minDurationMs, DEFAULT_MIN_DURATION_MS),
  };
}

function normalizeMidi(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  return {
    fileName: typeof raw.fileName === 'string' ? raw.fileName : '',
    ppq: toNonNegInt(raw.ppq, 0),
    format: toInt(raw.format, 0),
    tempoCount: toNonNegInt(raw.tempoCount, 0),
    importedAt: toNonNegInt(raw.importedAt, Date.now()),
  };
}

/**
 * TODO(接入点):lib/project.mjs 就绪后由 normalizeProject 接管;这里是等价的内置兜底。
 * 目标:任何脏输入都不许抛错,并且输出的 Project 满足 INTERFACE.md 第 1 节的不变量。
 */
export function fallbackNormalizeProject(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const now = Date.now();
  const tracks = (Array.isArray(src.tracks) ? src.tracks : [])
    .map((t, i) => normalizeTrack(t, i))
    .filter(Boolean);
  const maxEnd = tracks.reduce(
    (acc, t) => t.segments.reduce((a, s) => Math.max(a, s.endMs), acc),
    0,
  );
  const durationMs = toNonNegInt(src.durationMs, 0);
  return {
    id: isSafeId(src.id) ? src.id : null,
    name: typeof src.name === 'string' && src.name.trim() !== '' ? src.name.slice(0, 200) : '未命名项目',
    createdAt: toNonNegInt(src.createdAt, now),
    updatedAt: toNonNegInt(src.updatedAt, now),
    durationMs: durationMs > 0 ? durationMs : maxEnd,
    midi: normalizeMidi(src.midi),
    tracks,
    settings: normalizeSettings(src.settings),
    revision: Math.max(1, toNonNegInt(src.revision, 1)),
  };
}

// ---------------------------------------------------------------------------
// 导出(委托 lib/exporters.mjs;模块 A 的职责,服务端不实现任何字幕格式)
// ---------------------------------------------------------------------------
// 格式 key 以 lib/exporters.mjs 的 EXPORTERS 为准:srt / vtt / lrc / enhanced-lrc / ass。
// 另外保留 elrc、enhancedlrc 两个历史别名,避免老链接 404。
const EXPORT_EXT = {
  srt: '.srt',
  vtt: '.vtt',
  lrc: '.lrc',
  'enhanced-lrc': '.lrc',
  elrc: '.lrc',
  enhancedlrc: '.lrc',
  ass: '.ass',
};
const EXPORT_FN = {
  srt: 'toSRT',
  vtt: 'toVTT',
  lrc: 'toLRC',
  'enhanced-lrc': 'toEnhancedLRC',
  elrc: 'toEnhancedLRC',
  enhancedlrc: 'toEnhancedLRC',
  ass: 'toASS',
};
const KNOWN_FORMATS = Object.keys(EXPORT_EXT);

function safeFilename(name) {
  const cleaned = String(name ?? '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return cleaned === '' ? 'subtitle' : cleaned;
}

function contentDisposition(filename) {
  // eslint-disable-next-line no-control-regex
  const ascii = filename.replace(/[^\u0020-\u007e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

// ---------------------------------------------------------------------------
// handlers
// ---------------------------------------------------------------------------

/**
 * @param {{ store: ReturnType<typeof createStore>, staticRoot: string }} ctx
 */
export function createRequestHandler({ store, staticRoot }) {
  const root = path.resolve(staticRoot);
  let realRootPromise = null;
  const realRoot = () => {
    if (!realRootPromise) realRootPromise = fsp.realpath(root).catch(() => root);
    return realRootPromise;
  };

  // 绝对路径黑名单:数据目录、server/、tests/、node_modules/
  const denyAbs = [
    store.dataDir,
    path.join(REPO_ROOT, 'server'),
    path.join(REPO_ROOT, 'tests'),
    path.join(REPO_ROOT, 'node_modules'),
  ].map((p) => path.resolve(p));

  function isDenied(absPath, relPath) {
    if (denyAbs.some((deny) => isInsideOrEqual(deny, absPath))) return true;
    const segments = relPath.split(path.sep).filter((s) => s !== '');
    if (segments.length > 0 && DENY_TOP_DIRS.has(segments[0])) return true;
    if (segments.some((s) => s.startsWith('.'))) return true; // .git / .history / .env …
    return false;
  }

  // ---------------- 静态文件 ----------------
  async function serveStatic(req, res, rawPathname) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendJson(req, res, 405, { ok: false, error: 'method_not_allowed' }, { Allow: 'GET, HEAD' });
      return;
    }
    let decoded;
    try {
      decoded = decodeURIComponent(rawPathname);
    } catch {
      sendJson(req, res, 400, { ok: false, error: 'bad_path_encoding' });
      return;
    }
    // Windows 上 `\` 也是分隔符,先统一;`%5c` 解码后同样会被下面拦下
    const segments = decoded.replace(/\\/g, '/').split('/');
    // 任何 `..` 段一律拒绝(静态文件从不需要它),这是路径穿越的第一道闸
    if (segments.includes('..')) {
      sendJson(req, res, 403, { ok: false, error: 'path_traversal', path: rawPathname });
      return;
    }

    let rel = decoded.replace(/\\/g, '/').replace(/^\/+/, '');

    // `/` → 应用页。这里有一个必须讲清楚的坑:
    //
    // 应用页的候选是 public/index.html,但它引用的资源是**相对路径**
    // (index.html 里写的是 `js/ui.js`、`css/theme.css`,不带前导斜杠)。
    // 如果直接把这个文件的内容在 `/` 上返回,相对路径会解析到 `/js/ui.js`,
    // 而文件实际在 `/public/js/ui.js` —— 于是 CSS 和脚本全部 404,页面白屏。
    // (实测过:根路径返回 HTML,但 /js/ui.js、/css/*.css 都是 404。)
    //
    // 所以 `/` 必须**重定向**到真实文件路径,让浏览器以 /public/ 为基准解析
    // 相对路径。index.html 里 import 的 `../../lib/*.mjs` 也正好因此能解析到
    // 仓库根的 lib/(静态根是仓库根,lib/ 就在根下)。
    if (rel === '') {
      const entry = path.resolve(root, 'public/index.html');
      const relEntry = path.relative(root, entry);
      const inside = relEntry !== '..' && !relEntry.startsWith(`..${path.sep}`) && !path.isAbsolute(relEntry);
      let entryExists = false;
      try {
        entryExists = inside && (await fsp.stat(entry)).isFile();
      } catch {
        entryExists = false;
      }
      if (entryExists) {
        // 必须把查询串一起带过去。丢掉的话 `/?project=<id>` 这类深链会静默失效 ——
        // 用户以为打开了某个项目,实际拿到的是空白页,而且看不出哪里错了。
        const q = (req.url || '').includes('?') ? (req.url || '').slice((req.url || '').indexOf('?')) : '';
        res.writeHead(302, { location: `/public/index.html${q}`, 'cache-control': 'no-store' });
        res.end();
        return;
      }
      // 自定义 --root 下没有 public/ 时,退回 <root>/index.html
    }

    // 目录请求补 index.html;`/` 已在上面处理(要么 302,要么落到这里的根 index.html)
    const candidates = rel.endsWith('/') ? [`${rel}index.html`] : rel === '' ? ['index.html'] : [rel];

    for (const candidate of candidates) {
      const abs = path.resolve(root, candidate);
      const relToRoot = path.relative(root, abs);
      // 第二道闸:resolve 之后的绝对路径必须仍在静态根内
      if (relToRoot === '..' || relToRoot.startsWith(`..${path.sep}`) || path.isAbsolute(relToRoot)) {
        sendJson(req, res, 403, { ok: false, error: 'path_traversal', path: rawPathname });
        return;
      }
      // 第三道闸:黑名单(server/data、tests、node_modules、点开头的一切)
      if (isDenied(abs, relToRoot)) {
        sendJson(req, res, 403, { ok: false, error: 'forbidden_path', path: rawPathname });
        return;
      }

      let stat;
      try {
        stat = await fsp.stat(abs);
      } catch {
        continue; // 换下一个候选(例如 public/index.html 还不存在)
      }
      if (stat.isDirectory()) {
        const indexAbs = path.join(abs, 'index.html');
        try {
          stat = await fsp.stat(indexAbs);
          return await sendFile(req, res, indexAbs, stat, decoded);
        } catch {
          sendText(req, res, 404, `404 Not Found (no index.html in directory): ${decoded}\n`);
          return;
        }
      }

      // 符号链接再兜一次:realpath 后必须仍在静态根内
      try {
        const real = await fsp.realpath(abs);
        const realBase = await realRoot();
        if (!isInsideOrEqual(realBase, real)) {
          sendJson(req, res, 403, { ok: false, error: 'forbidden_path', path: rawPathname });
          return;
        }
      } catch {
        continue;
      }

      return sendFile(req, res, abs, stat, decoded);
    }

    sendText(req, res, 404, `404 Not Found: ${decoded}\n`);
  }

  async function sendFile(req, res, abs, stat, displayPath) {
    let body;
    try {
      // 本项目静态资源都很小(MIDI 样本 ~7KB),一次性读;若将来有大文件再换流式
      body = await fsp.readFile(abs);
    } catch {
      sendText(req, res, 404, `404 Not Found: ${displayPath}\n`);
      return;
    }
    res.writeHead(
      200,
      corsHeaders({
        'Content-Type': mimeOf(abs),
        'Content-Length': body.length,
        'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff',
      }),
    );
    if (req.method === 'HEAD') res.end();
    else res.end(body);
  }

  // ---------------- API ----------------
  async function handleApi(req, res, rawPathname, searchParams) {
    const parts = rawPathname
      .split('/')
      .filter((s) => s !== '')
      .map((s) => {
        try {
          return decodeURIComponent(s);
        } catch {
          return s;
        }
      });
    const method = req.method ?? 'GET';

    if (method === 'OPTIONS') {
      res.writeHead(204, corsHeaders({ Allow: 'GET,POST,PUT,PATCH,DELETE,OPTIONS' }));
      res.end();
      return;
    }

    // /api/health
    if (parts.length === 2 && parts[1] === 'health') {
      if (method !== 'GET' && method !== 'HEAD') {
        sendJson(req, res, 405, { ok: false, error: 'method_not_allowed' }, { Allow: 'GET, HEAD' });
        return;
      }
      sendJson(req, res, 200, { ok: true, kind: 'server', version: VERSION });
      return;
    }

    if (parts[1] !== 'projects') {
      sendJson(req, res, 404, { ok: false, error: 'not_found', path: rawPathname });
      return;
    }

    // /api/projects
    if (parts.length === 2) {
      if (method === 'GET' || method === 'HEAD') {
        sendJson(req, res, 200, await store.listProjects());
        return;
      }
      if (method === 'POST') {
        const body = await readJsonBody(req);
        const raw = body && typeof body === 'object' && body.project ? body.project : body;
        const project = await normalizeProjectSafely(raw);
        const created = await store.createProject(project);
        sendJson(req, res, 201, created);
        return;
      }
      sendJson(req, res, 405, { ok: false, error: 'method_not_allowed' }, { Allow: 'GET, POST' });
      return;
    }

    const id = parts[2];
    if (!isSafeId(id)) {
      // 非法 id 不可能存在(也堵住 /api/projects/..%2f.. 这类)
      sendJson(req, res, 404, { ok: false, error: 'project_not_found', id });
      return;
    }

    // /api/projects/:id
    if (parts.length === 3) {
      if (method === 'GET' || method === 'HEAD') {
        const project = await store.readProject(id);
        if (!project) {
          sendJson(req, res, 404, { ok: false, error: 'project_not_found', id });
          return;
        }
        sendJson(req, res, 200, project);
        return;
      }
      if (method === 'PUT') {
        const body = await readJsonBody(req);
        const raw = body && typeof body === 'object' && body.project ? body.project : body;
        const baseRevision =
          body && typeof body === 'object' && body.baseRevision !== undefined ? body.baseRevision : null;
        const project = await normalizeProjectSafely(raw);
        const saved = await store.saveProject(id, project, { baseRevision });
        sendJson(req, res, 200, { id: saved.id, revision: saved.revision, updatedAt: saved.updatedAt });
        return;
      }
      if (method === 'PATCH') {
        const body = await readJsonBody(req);
        const name = typeof body?.name === 'string' ? body.name.trim() : '';
        if (name === '' || name.length > 200) {
          sendJson(req, res, 400, { ok: false, error: 'invalid_name' });
          return;
        }
        const renamed = await store.renameProject(id, name);
        sendJson(req, res, 200, renamed);
        return;
      }
      if (method === 'DELETE') {
        const existed = await store.deleteProject(id);
        if (!existed) {
          sendJson(req, res, 404, { ok: false, error: 'project_not_found', id });
          return;
        }
        sendJson(req, res, 200, { ok: true, id, deleted: true });
        return;
      }
      sendJson(req, res, 405, { ok: false, error: 'method_not_allowed' }, { Allow: 'GET, PUT, PATCH, DELETE' });
      return;
    }

    // /api/projects/:id/history
    if (parts.length === 4 && parts[3] === 'history') {
      if (method !== 'GET' && method !== 'HEAD') {
        sendJson(req, res, 405, { ok: false, error: 'method_not_allowed' }, { Allow: 'GET' });
        return;
      }
      if (!(await store.readProject(id))) {
        sendJson(req, res, 404, { ok: false, error: 'project_not_found', id });
        return;
      }
      sendJson(req, res, 200, await store.listHistory(id));
      return;
    }

    // /api/projects/:id/restore
    if (parts.length === 4 && parts[3] === 'restore') {
      if (method !== 'POST') {
        sendJson(req, res, 405, { ok: false, error: 'method_not_allowed' }, { Allow: 'POST' });
        return;
      }
      const body = await readJsonBody(req);
      const revision = toInt(body?.revision, NaN);
      if (!Number.isFinite(revision) || revision < 1) {
        sendJson(req, res, 400, { ok: false, error: 'invalid_revision' });
        return;
      }
      const restored = await store.restoreRevision(id, revision);
      sendJson(req, res, 200, restored);
      return;
    }

    // /api/projects/:id/export/:format
    if (parts.length === 5 && parts[3] === 'export') {
      if (method !== 'GET' && method !== 'HEAD') {
        sendJson(req, res, 405, { ok: false, error: 'method_not_allowed' }, { Allow: 'GET' });
        return;
      }
      await handleExport(req, res, id, String(parts[4] ?? '').toLowerCase(), searchParams);
      return;
    }

    sendJson(req, res, 404, { ok: false, error: 'not_found', path: rawPathname });
  }

  async function handleExport(req, res, id, format, searchParams) {
    if (!KNOWN_FORMATS.includes(format)) {
      sendJson(req, res, 404, {
        ok: false,
        error: 'unknown_format',
        format,
        available: KNOWN_FORMATS,
      });
      return;
    }
    const project = await store.readProject(id);
    if (!project) {
      sendJson(req, res, 404, { ok: false, error: 'project_not_found', id });
      return;
    }
    const { mod, error } = await loadLib('exporters.mjs');
    if (!mod) {
      // TODO(接入点):模块 A 的 lib/exporters.mjs 就绪后自动生效
      sendJson(req, res, 501, {
        ok: false,
        error: 'exporters_unavailable',
        detail: error?.message ?? 'lib/exporters.mjs not loaded',
      });
      return;
    }
    const meta = mod.EXPORTERS?.[format] ?? mod.EXPORTERS?.[EXPORT_FN[format]] ?? null;
    const fn = typeof meta === 'function' ? meta : (meta?.fn ?? mod[EXPORT_FN[format]]);
    if (typeof fn !== 'function') {
      sendJson(req, res, 501, {
        ok: false,
        error: 'exporter_missing',
        format,
        available: Object.keys(mod.EXPORTERS ?? {}),
      });
      return;
    }
    const opts = {
      title: project.name,
      includeHidden: searchParams?.get('includeHidden') === '1',
      includeMeta: searchParams?.get('includeMeta') === '1',
    };
    let text;
    try {
      text = fn(project.tracks ?? [], opts);
    } catch (err) {
      sendJson(req, res, 500, { ok: false, error: 'export_failed', detail: err?.message ?? String(err) });
      return;
    }
    const ext = meta?.ext ?? EXPORT_EXT[format];
    let mime = meta?.mime ?? 'text/plain; charset=utf-8';
    if (!/charset=/i.test(mime) && /^text\/|application\/(json|xml)/.test(mime)) mime += '; charset=utf-8';
    const filename = `${safeFilename(project.name)}${ext}`;
    if (res.headersSent) {
      res.destroy();
      return;
    }
    const body = Buffer.from(String(text ?? ''), 'utf8');
    res.writeHead(
      200,
      corsHeaders({
        'Content-Type': mime,
        'Content-Length': body.length,
        'Content-Disposition': contentDisposition(filename),
        'Cache-Control': 'no-store',
      }),
    );
    if (req.method === 'HEAD') res.end();
    else res.end(body);
  }

  // ---------------- 统一入口 ----------------
  return async function handle(req, res) {
    const rawUrl = req.url ?? '/';
    const qIndex = rawUrl.indexOf('?');
    const rawPathname = qIndex >= 0 ? rawUrl.slice(0, qIndex) : rawUrl;
    const searchParams =
      qIndex >= 0 ? new URLSearchParams(rawUrl.slice(qIndex + 1)) : new URLSearchParams();
    try {
      if (rawPathname === '/api' || rawPathname.startsWith('/api/')) {
        await handleApi(req, res, rawPathname, searchParams);
        return;
      }
      await serveStatic(req, res, rawPathname);
    } catch (err) {
      if (err instanceof RevisionConflictError) {
        // currentRevision 是契约字段;revision 是给 public/js/store.js 的兼容别名
        // (它读 payload.revision ?? payload.currentRevision)
        sendJson(req, res, 409, {
          ok: false,
          error: 'revision_conflict',
          currentRevision: err.currentRevision,
          revision: err.currentRevision,
        });
        return;
      }
      if (err instanceof NotFoundError) {
        sendJson(req, res, 404, { ok: false, error: 'not_found', what: err.what });
        return;
      }
      if (err instanceof AlreadyExistsError) {
        sendJson(req, res, 409, { ok: false, error: 'already_exists', id: err.id });
        return;
      }
      if (err instanceof StoreError) {
        sendJson(req, res, 400, { ok: false, error: err.code, detail: err.message });
        return;
      }
      const status = Number(err?.statusCode) || 500;
      if (status >= 500) console.error('[server] request failed:', err);
      sendJson(req, res, status, {
        ok: false,
        error: status === 400 ? 'bad_request' : status === 413 ? 'payload_too_large' : 'internal_error',
        detail: err?.message ?? String(err),
      });
    }
  };
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------

export function parseArgs(argv) {
  const out = { port: null, host: '127.0.0.1', dataDir: null, root: null, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const [flag, inlineValue] = arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, null];
    const nextValue = () => {
      const value = inlineValue !== null ? inlineValue : argv[++i];
      if (value === undefined) throw new Error(`选项 ${flag} 缺少取值`);
      return value;
    };
    switch (flag) {
      case '--port':
      case '-p':
        out.port = Number(nextValue());
        break;
      case '--host':
        out.host = String(nextValue());
        break;
      case '--data-dir':
        out.dataDir = String(nextValue());
        break;
      case '--root':
        out.root = String(nextValue());
        break;
      case '--help':
      case '-h':
        out.help = true;
        break;
      default:
        console.warn(`[server] ignoring unknown argument: ${arg}`);
    }
  }
  return out;
}

export const USAGE = `用法: node server/server.mjs [选项]

  --port <n>       监听端口(默认 4517,环境变量 DSH_SUB_PORT 可覆盖;0 = 由系统分配)
  --host <addr>    监听地址(默认 127.0.0.1)
  --data-dir <dir> 数据目录(默认 server/data;环境变量 DSH_SUB_DATA_DIR 可覆盖)
  --root <dir>     静态文件根(默认仓库根;环境变量 DSH_SUB_ROOT 可覆盖)
  -h, --help       显示本帮助
`;

export async function startServer(options = {}) {
  const args = parseArgs(process.argv.slice(2));
  const envPort = process.env.DSH_SUB_PORT ? Number(process.env.DSH_SUB_PORT) : null;
  const port = options.port ?? args.port ?? envPort ?? DEFAULT_PORT;
  const host = options.host ?? args.host;
  const dataDir = path.resolve(
    options.dataDir ?? args.dataDir ?? process.env.DSH_SUB_DATA_DIR ?? path.join(HERE, 'data'),
  );
  const staticRoot = path.resolve(options.root ?? args.root ?? process.env.DSH_SUB_ROOT ?? REPO_ROOT);

  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`invalid port: ${port}`);
  }

  const store = createStore({ dataDir });
  const handler = createRequestHandler({ store, staticRoot });
  const server = http.createServer((req, res) => {
    handler(req, res).catch((err) => {
      console.error('[server] unhandled handler error:', err);
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end('{"ok":false,"error":"internal_error"}');
    });
  });
  server.keepAliveTimeout = 5000;

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  const actualPort = server.address().port;
  return {
    server,
    store,
    port: actualPort,
    host,
    staticRoot,
    dataDir,
    async close() {
      await new Promise((resolve) => server.close(resolve));
      await store.drain();
    },
  };
}

const isMain = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    const a = fs.realpathSync.native(entry);
    const b = fs.realpathSync.native(fileURLToPath(import.meta.url));
    return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  } catch {
    return entry.endsWith('server.mjs');
  }
})();

if (isMain) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
      process.stdout.write(USAGE);
      process.exit(0);
    }
    const { server, port, host, staticRoot, dataDir } = await startServer();
    // 把实际监听端口打印出来:用 `--port 0` 时端口由系统分配,调用方需要从这里拿到
    process.stdout.write(`[server] listening on http://${host}:${port}\n`);
    process.stdout.write(`[server] port=${port}\n`);
    process.stdout.write(`[server] static root: ${staticRoot}\n`);
    process.stdout.write(`[server] data dir: ${dataDir}\n`);

    const shutdown = (signal) => {
      process.stdout.write(`[server] ${signal} received, shutting down\n`);
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 800).unref();
    };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
  } catch (err) {
    console.error(`[server] failed to start: ${err?.message ?? err}`);
    process.exit(1);
  }
}
