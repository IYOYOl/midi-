/**
 * store.js — 持久化适配器(模块 C,契约见 INTERFACE.md 第 4 节)
 *
 * 两种实现,运行时二选一:
 *   createServerStore(baseUrl)  —— REST(服务端是唯一真相)
 *   createLocalStore()          —— localStorage(纯静态部署,功能不缩水)
 * detectStore() 探测 GET /api/health:通(1.5s 内)用 server,否则落 local。
 *
 * 约束:零依赖、浏览器原生 ESM、可在 Node 下 import(不碰 DOM;storage / fetch 可注入)。
 */

export const KEY_PREFIX = 'midi2srt:';
export const KEY_INDEX = KEY_PREFIX + 'index';
export const KEY_PROJECT = KEY_PREFIX + 'proj:';
export const KEY_HISTORY = KEY_PREFIX + 'hist:';
export const KEY_SNAPSHOT = KEY_PREFIX + 'snap:';
export const KEY_LAST_PROJECT = KEY_PREFIX + 'lastProjectId';
export const KEY_MIRROR = KEY_PREFIX + 'mirror:';
export const KEY_BACKUP = KEY_PREFIX + 'backup:';

export const HISTORY_LIMIT = 30;
export const HEALTH_PATH = '/api/health';
export const DEFAULT_TIMEOUT_MS = 1500;

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

function nowMs() {
  return Date.now();
}

function uid(prefix) {
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${nowMs()}_${rand}`;
}

/** 深拷贝(优先 structuredClone,退化到 JSON) */
export function clone(value) {
  if (value === null || typeof value !== 'object') return value;
  try {
    if (typeof structuredClone === 'function') return structuredClone(value);
  } catch {
    /* 含不可克隆字段时退化 */
  }
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return value;
  }
}

function asInt(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function byteLength(text) {
  try {
    return new TextEncoder().encode(text).length;
  } catch {
    return String(text).length;
  }
}

/** 内存版 Storage:localStorage 不可用时兜底(至少本次会话不丢) */
export function createMemoryStorage(initial) {
  const map = new Map(initial ? Object.entries(initial) : []);
  return {
    persistent: false,
    get length() {
      return map.size;
    },
    key(i) {
      return [...map.keys()][i] ?? null;
    },
    getItem(k) {
      const key = String(k);
      return map.has(key) ? map.get(key) : null;
    },
    setItem(k, v) {
      map.set(String(k), String(v));
    },
    removeItem(k) {
      map.delete(String(k));
    },
    clear() {
      map.clear();
    },
    raw: map,
  };
}

/** 取用 localStorage(带可用性探测),不可用则落内存实现 */
export function resolveStorage(injected) {
  if (injected) return injected;
  // 浏览器之外不要碰 globalThis.localStorage:
  // Node 22+ 有这个全局,但它是实验性的,访问会打 ExperimentalWarning
  // (「localStorage is not available because --localstorage-file was not provided」),
  // 还会打出一条实验性 API 警告。非浏览器环境本来就没有持久化存储,直接走内存实现。
  const inBrowser = typeof window !== 'undefined' && typeof window.document !== 'undefined';
  if (!inBrowser) return createMemoryStorage();
  try {
    const ls = globalThis.localStorage;
    if (ls) {
      const probe = KEY_PREFIX + 'probe';
      ls.setItem(probe, '1');
      ls.removeItem(probe);
      return ls;
    }
  } catch {
    /* 隐私模式 / 沙箱 / file:// 下 localStorage 可能抛错 */
  }
  return createMemoryStorage();
}

function isPersistent(storage) {
  return !!storage && storage.persistent !== false;
}

function storageKeys(storage) {
  const keys = [];
  try {
    if (typeof storage.key === 'function' && typeof storage.length === 'number') {
      for (let i = 0; i < storage.length; i += 1) {
        const k = storage.key(i);
        if (k != null) keys.push(k);
      }
      return keys;
    }
  } catch {
    /* 落到下面 */
  }
  if (storage && storage.raw instanceof Map) keys.push(...storage.raw.keys());
  return keys;
}

function safeRemove(storage, key) {
  try {
    storage.removeItem(key);
  } catch {
    /* 忽略 */
  }
}

function joinUrl(baseUrl, path) {
  const base = String(baseUrl ?? '').replace(/\/+$/, '');
  return base + path;
}

/** 浏览器里 baseUrl 为空时,以文档目录为基准(静态部署挂子路径也安全,不硬编码绝对路径) */
function defaultBaseUrl() {
  try {
    if (typeof document !== 'undefined' && document && document.baseURI) {
      return new URL('.', document.baseURI).href.replace(/\/+$/, '');
    }
  } catch {
    /* 落到空串 */
  }
  return '';
}

/* ------------------------------------------------------------------ *
 * createLocalStore —— localStorage 实现(静态部署)
 * ------------------------------------------------------------------ */

export function createLocalStore(opts = {}) {
  const storage = resolveStorage(opts.storage);
  const persistent = opts.storage ? opts.storage.persistent !== false : isPersistent(storage);

  function fail(action, err) {
    return new Error(`本地存储${action}失败:${err && err.message ? err.message : err}`);
  }

  function readIndex() {
    try {
      const raw = storage.getItem(KEY_INDEX);
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr.filter((x) => typeof x === 'string' && x) : [];
    } catch {
      return [];
    }
  }

  function writeIndex(ids) {
    try {
      storage.setItem(KEY_INDEX, JSON.stringify([...new Set(ids)]));
    } catch (err) {
      throw fail('写入索引', err);
    }
  }

  function addToIndex(id) {
    const ids = readIndex();
    if (!ids.includes(id)) {
      ids.push(id);
      writeIndex(ids);
    }
  }

  function readRaw(id) {
    const raw = storage.getItem(KEY_PROJECT + id);
    if (raw == null) return null;
    try {
      const p = JSON.parse(raw);
      return p && typeof p === 'object' ? p : null;
    } catch (err) {
      throw new Error(`项目数据损坏,无法解析:${id}`);
    }
  }

  function readRawSafe(id) {
    try {
      return readRaw(id);
    } catch {
      return null;
    }
  }

  function writeProject(project) {
    try {
      storage.setItem(KEY_PROJECT + project.id, JSON.stringify(project));
    } catch (err) {
      throw fail('写入项目', err);
    }
  }

  function snapKey(id, revision) {
    return `${KEY_SNAPSHOT}${id}:${asInt(revision)}`;
  }

  function readHistory(id) {
    try {
      const raw = storage.getItem(KEY_HISTORY + id);
      const arr = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(arr)) return [];
      return arr
        .filter((e) => e && Number.isFinite(Number(e.revision)))
        .map((e) => ({
          revision: asInt(e.revision),
          savedAt: asInt(e.savedAt),
          bytes: asInt(e.bytes),
        }))
        .sort((a, b) => a.revision - b.revision);
    } catch {
      return [];
    }
  }

  function writeHistory(id, entries) {
    const sorted = entries.slice().sort((a, b) => a.revision - b.revision);
    const keep = sorted.slice(-HISTORY_LIMIT);
    const dropped = sorted.slice(0, Math.max(0, sorted.length - HISTORY_LIMIT));
    for (const e of dropped) safeRemove(storage, snapKey(id, e.revision));
    try {
      storage.setItem(KEY_HISTORY + id, JSON.stringify(keep));
    } catch (err) {
      throw fail('写入历史索引', err);
    }
  }

  /** 每次成功写入都留一份快照(保留最近 HISTORY_LIMIT 份) */
  function snapshot(project) {
    try {
      const text = JSON.stringify(project);
      storage.setItem(snapKey(project.id, project.revision), text);
      const entries = readHistory(project.id).filter((e) => e.revision !== asInt(project.revision));
      entries.push({ revision: asInt(project.revision), savedAt: nowMs(), bytes: byteLength(text) });
      writeHistory(project.id, entries);
    } catch (err) {
      if (err instanceof Error && /本地存储/.test(err.message)) throw err;
      throw fail('写入快照', err);
    }
  }

  function requireProject(id) {
    if (!id) throw new Error('缺少项目 id');
    const p = readRaw(id);
    if (!p) throw new Error(`项目不存在:${id}`);
    return p;
  }

  const api = {
    kind: 'local',
    persistent,
    storage,
    label: persistent ? '本地存储(浏览器)' : '内存存储(浏览器禁止了本地存储)',

    async listProjects() {
      const seen = new Set();
      const out = [];
      const push = (p) => {
        if (!p || !p.id || seen.has(p.id)) return;
        seen.add(p.id);
        out.push({
          id: p.id,
          name: typeof p.name === 'string' && p.name ? p.name : '未命名项目',
          updatedAt: asInt(p.updatedAt),
          createdAt: asInt(p.createdAt),
          revision: asInt(p.revision, 1),
          durationMs: asInt(p.durationMs),
          trackCount: Array.isArray(p.tracks) ? p.tracks.length : 0,
          segmentCount: Array.isArray(p.tracks)
            ? p.tracks.reduce((n, t) => n + (Array.isArray(t && t.segments) ? t.segments.length : 0), 0)
            : 0,
        });
      };
      for (const id of readIndex()) push(readRawSafe(id));
      // 索引与数据不一致时自愈:扫一遍项目键补齐
      for (const key of storageKeys(storage)) {
        if (key.startsWith(KEY_PROJECT)) push(readRawSafe(key.slice(KEY_PROJECT.length)));
      }
      out.sort((a, b) => b.updatedAt - a.updatedAt);
      return out;
    },

    async createProject(project) {
      const p = clone(project) || {};
      if (typeof p.name !== 'string' || !p.name) p.name = '未命名项目';
      if (typeof p.id !== 'string' || !p.id) p.id = uid('p');
      p.createdAt = asInt(p.createdAt) || nowMs();
      p.updatedAt = nowMs();
      p.revision = 1;
      if (!Array.isArray(p.tracks)) p.tracks = [];
      if (!p.settings || typeof p.settings !== 'object') p.settings = {};
      writeProject(p);
      addToIndex(p.id);
      snapshot(p);
      return clone(p);
    },

    async loadProject(id) {
      return clone(requireProject(id));
    },

    async saveProject(project) {
      if (!project || typeof project !== 'object') throw new Error('saveProject 需要一个项目对象');
      if (!project.id) return api.createProject(project);
      const current = requireProject(project.id);
      const p = clone(project);
      p.id = project.id;
      p.createdAt = asInt(current.createdAt) || asInt(p.createdAt) || nowMs();
      p.revision = asInt(current.revision, 0) + 1; // 服务端持有 revision,客户端只读:这里由适配器递增
      p.updatedAt = nowMs();
      writeProject(p);
      snapshot(p);
      return clone(p);
    },

    async getHistory(id) {
      requireProject(id);
      return readHistory(id).sort((a, b) => b.revision - a.revision);
    },

    async restoreRevision(id, revision) {
      const current = requireProject(id);
      const raw = storage.getItem(snapKey(id, revision));
      if (raw == null) throw new Error(`快照不存在:revision ${revision}`);
      let snap;
      try {
        snap = JSON.parse(raw);
      } catch {
        throw new Error(`快照损坏:revision ${revision}`);
      }
      const p = clone(snap) || {};
      p.id = id;
      p.createdAt = asInt(current.createdAt) || asInt(p.createdAt) || nowMs();
      p.revision = asInt(current.revision, 0) + 1; // 与服务端一致:用快照覆盖并 +1
      p.updatedAt = nowMs();
      writeProject(p);
      snapshot(p);
      return clone(p);
    },

    async renameProject(id, name) {
      const current = requireProject(id);
      const clean = String(name ?? '').trim();
      current.name = clean || current.name || '未命名项目';
      current.updatedAt = nowMs();
      // 重命名也必须 +1 并留快照,与服务端 PATCH 完全一致 ——
      // INTERFACE §5:revision 唯一标识内容状态,两个适配器必须产生同样的 revision 序列。
      // 不 +1 的话「改内容」和「只改名字」会共用同一个 revision,
      // 后写的快照覆盖前一份,restore 会还给用户一个从未存在过的组合。
      current.revision = asInt(current.revision, 0) + 1;
      writeProject(current);
      snapshot(current);
      return clone(current);
    },

    async deleteProject(id) {
      const projectKeys = storageKeys(storage);
      for (const key of projectKeys) {
        if (key.startsWith(`${KEY_SNAPSHOT}${id}:`)) safeRemove(storage, key);
      }
      safeRemove(storage, KEY_PROJECT + id);
      safeRemove(storage, KEY_HISTORY + id);
      safeRemove(storage, KEY_MIRROR + id);
      safeRemove(storage, KEY_BACKUP + id);
      writeIndex(readIndex().filter((x) => x !== id));
      try {
        if (storage.getItem(KEY_LAST_PROJECT) === id) storage.removeItem(KEY_LAST_PROJECT);
      } catch {
        /* 忽略 */
      }
    },

    /** 清空本适配器写入的一切(用于「删除全部数据」这类维护操作)*/
    async clearAll() {
      for (const key of storageKeys(storage)) {
        if (key.startsWith(KEY_PREFIX)) safeRemove(storage, key);
      }
    },
  };

  return api;
}

/* ------------------------------------------------------------------ *
 * createServerStore —— REST 实现(服务端是唯一真相)
 * ------------------------------------------------------------------ */

function httpError(status, message, payload) {
  const err = new Error(message);
  err.status = status;
  err.payload = payload;
  err.offline = status === 0;
  if (status === 409) {
    err.code = 'CONFLICT';
    err.currentRevision = payload && (payload.revision ?? payload.currentRevision);
  }
  return err;
}

function errorMessage(status, payload) {
  if (payload && typeof payload === 'object') {
    if (typeof payload.error === 'string' && payload.error) return payload.error;
    if (typeof payload.message === 'string' && payload.message) return payload.message;
  }
  if (typeof payload === 'string' && payload.trim()) return payload.trim().slice(0, 200);
  return `服务端返回 ${status}`;
}

function unwrapProject(data) {
  if (!data || typeof data !== 'object') return null;
  if (data.project && typeof data.project === 'object') return data.project;
  return data;
}

function normalizeListRow(row) {
  if (!row || typeof row !== 'object') return null;
  const id = typeof row.id === 'string' ? row.id : null;
  if (!id) return null;
  return {
    id,
    name: typeof row.name === 'string' && row.name ? row.name : '未命名项目',
    updatedAt: asInt(row.updatedAt),
    createdAt: asInt(row.createdAt),
    revision: asInt(row.revision, 1),
    durationMs: asInt(row.durationMs),
    trackCount: asInt(row.trackCount),
    segmentCount: asInt(row.segmentCount),
  };
}

export function createServerStore(baseUrl = '', opts = {}) {
  const base = String(baseUrl ?? defaultBaseUrl());
  const fetchImpl = 'fetchImpl' in opts ? opts.fetchImpl : typeof fetch === 'function' ? fetch.bind(globalThis) : null;
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : 20000;

  const url = (path) => joinUrl(base, path);
  const projectPath = (id) => `/api/projects/${encodeURIComponent(id)}`;

  /**
   * 本项目最后一次确认过的服务端 revision。
   *
   * 为什么要记:保存时必须把「我是基于哪一版改的」告诉服务端(baseRevision),
   * 服务端才能发现"别人在我之后也写过"。不带的话服务端无从判断,
   * 两个标签页同时编辑就会静默后写覆盖 —— 用户丢改动且没有任何提示。
   *
   * 值在 loadProject / createProject / saveProject / restoreRevision 成功时更新,
   * 并允许调用方用 forgetRevision(id) 主动丢弃(例如已重新拉取服务端最新版本)。
   */
  const knownRevision = new Map();
  const setKnown = (id, rev) => {
    const n = asInt(rev, 0);
    if (id && n > 0) knownRevision.set(String(id), n);
  };

  async function request(method, path, body) {
    if (!fetchImpl) throw httpError(0, '当前环境没有 fetch,无法访问服务端');
    const init = { method, headers: { accept: 'application/json' } };
    if (body !== undefined) {
      init.headers['content-type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    let timer = null;
    let ac = null;
    if (timeoutMs > 0 && typeof AbortController === 'function') {
      ac = new AbortController();
      init.signal = ac.signal;
      timer = setTimeout(() => ac.abort(), timeoutMs);
    }
    let res;
    try {
      res = await fetchImpl(url(path), init);
    } catch (err) {
      if (err && err.name === 'AbortError') throw httpError(0, `请求超时:${method} ${path}`);
      throw httpError(0, `无法连接服务端:${err && err.message ? err.message : err}`);
    } finally {
      if (timer) clearTimeout(timer);
    }
    const text = await res.text().catch(() => '');
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }
    if (!res.ok) throw httpError(res.status, errorMessage(res.status, data), data);
    return data;
  }

  const store = {
    kind: 'server',
    persistent: true,
    baseUrl: base,
    label: '服务端',

    async listProjects() {
      const data = await request('GET', '/api/projects');
      const rows = Array.isArray(data) ? data : Array.isArray(data && data.projects) ? data.projects : [];
      return rows.map(normalizeListRow).filter(Boolean).sort((a, b) => b.updatedAt - a.updatedAt);
    },

    async createProject(project) {
      const local = clone(project) || {};
      const data = await request('POST', '/api/projects', local);
      const remote = unwrapProject(data) || {};
      // 服务端可能只回 { id, revision, updatedAt }:合并回完整项目
      const merged = { ...local, ...remote };
      if (!merged.id) throw httpError(500, '服务端未返回项目 id', data);
      merged.revision = asInt(merged.revision, 1) || 1;
      setKnown(merged.id, merged.revision);
      return clone(merged);
    },

    async loadProject(id) {
      const data = await request('GET', projectPath(id));
      const p = unwrapProject(data);
      if (!p || !p.id) throw httpError(500, `服务端未返回项目:${id}`, data);
      setKnown(p.id, p.revision);
      return clone(p);
    },

    /** 丢弃已知 revision:调用方已重新拉取服务端最新版本后,应以那一版为基准 */
    forgetRevision(id) {
      knownRevision.delete(String(id));
    },

    /** 当前记录的基准 revision(排查并发冲突时有用)*/
    knownRevisionOf(id) {
      return knownRevision.get(String(id)) ?? null;
    },

    async saveProject(project) {
      if (!project || typeof project !== 'object') throw new Error('saveProject 需要一个项目对象');
      if (!project.id) return store.createProject(project);
      const local = clone(project);
      const id = String(local.id);
      // 带上基准版本,让服务端能拒绝"基于过期版本的写入"。
      // 已知优先;未知时退回项目对象自带的 revision(通常是刚 load 出来的那一版)。
      const base = knownRevision.has(id) ? knownRevision.get(id) : asInt(local.revision, 0);
      const payload = { project: local };
      if (base > 0) payload.baseRevision = base;
      const data = await request('PUT', projectPath(id), payload);
      const remote = unwrapProject(data) || {};
      const merged = { ...local, ...remote };
      merged.id = remote.id ?? local.id;
      merged.revision = asInt(merged.revision, asInt(local.revision));
      merged.updatedAt = asInt(merged.updatedAt) || nowMs();
      setKnown(merged.id, merged.revision);
      return clone(merged);
    },

    async getHistory(id) {
      const data = await request('GET', `${projectPath(id)}/history`);
      const rows = Array.isArray(data) ? data : Array.isArray(data && data.history) ? data.history : [];
      return rows
        .filter((e) => e && Number.isFinite(Number(e.revision)))
        .map((e) => ({
          revision: asInt(e.revision),
          savedAt: asInt(e.savedAt),
          bytes: asInt(e.bytes),
        }))
        .sort((a, b) => b.revision - a.revision);
    },

    async restoreRevision(id, revision) {
      const data = await request('POST', `${projectPath(id)}/restore`, { revision: asInt(revision) });
      const p = unwrapProject(data);
      if (p && p.id && Array.isArray(p.tracks)) {
        setKnown(p.id, p.revision);
        return clone(p);
      }
      return store.loadProject(id); // 服务端只回了 { id, revision } 时再拉一次完整项目(loadProject 会更新基准)
    },

    async renameProject(id, name) {
      const data = await request('PATCH', projectPath(id), { name: String(name ?? '') });
      const p = unwrapProject(data);
      if (p && Array.isArray(p.tracks)) {
        setKnown(p.id, p.revision);
        return clone(p);
      }
      const current = await store.loadProject(id);
      const merged = {
        ...current,
        name: (p && p.name) || String(name ?? '').trim() || current.name,
        revision: asInt(p && p.revision, current.revision),
        updatedAt: asInt(p && p.updatedAt) || nowMs(),
      };
      setKnown(id, merged.revision);
      return clone(merged);
    },

    async deleteProject(id) {
      await request('DELETE', projectPath(id));
    },

    /** 服务端直出导出文本(可选能力,界面默认走浏览器内导出) */
    async exportText(id, format) {
      return request('GET', `${projectPath(id)}/export/${encodeURIComponent(format)}`);
    },

    request,
  };

  return store;
}

/* ------------------------------------------------------------------ *
 * detectStore —— 探测服务端,失败/超时落到 local(绝不抛出去)
 * ------------------------------------------------------------------ */

export async function detectStore(opts = {}) {
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;
  const fetchImpl = 'fetchImpl' in opts ? opts.fetchImpl : typeof fetch === 'function' ? fetch.bind(globalThis) : null;

  const info = {
    ok: false,
    kind: 'local',
    reason: 'unknown',
    url: null,
    tried: [],
    timeoutMs,
    at: nowMs(),
  };

  const useLocal = (reason, err) => {
    info.ok = false;
    info.kind = 'local';
    info.reason = reason;
    if (err) info.error = String(err.message || err);
    const s = createLocalStore(opts.local || {});
    s.probe = info;
    return s;
  };

  // file:// 下 fetch 不可用,直接本地(静态部署双击打开的情况)
  try {
    if (typeof location !== 'undefined' && location && location.protocol === 'file:') {
      return useLocal('file-protocol');
    }
  } catch {
    /* 忽略 */
  }

  if (!fetchImpl) return useLocal('no-fetch');

  /**
   * 候选基准列表。
   *
   * 为什么要有多个:同一个后端,页面可能从不同层级打开 ——
   * 服务端模式下应用页是 /public/index.html(因为 public/js/*.js 用 `../../lib/`
   * 往上两级找 lib/,静态根必须是仓库根),这时页面目录是 /public/,相对探测
   * `api/health` 会解析成 /public/api/health 而 404,误降级成本地存储。
   * 而静态部署时页面在站点根,`api/health` 才是对的。
   *
   * 所以这里以**页面所在目录为基准**列出所有常见布局的候选,依次探测,
   * 命中即用;全都不通才落 localStorage。不要写死某一个入口路径 ——
   * 那正是这里踩过的坑。
   */
  const candidates = [];
  const push = (b) => {
    let v = String(b ?? '').replace(/\/+$/, '');
    // 折叠 '.' / '..' 段。`/public/..` 这种字符串如果原样拼上 /api/health,
    // 服务端收到的就是 /public/../api/health 而不是 /api/health ——
    // 浏览器发请求时也会做这层规范化,但这里不能指望它,必须在生成候选时就折掉。
    if (/^https?:\/\//i.test(v)) {
      try {
        v = new URL(v).href.replace(/\/+$/, '');
      } catch {
        /* 保持原样 */
      }
    }
    if (!candidates.includes(v)) candidates.push(v);
  };
  if (opts.baseUrl !== undefined) {
    push(opts.baseUrl);
  } else {
    const page = defaultBaseUrl(); // 页面目录的绝对 URL(无 document 时为空串)
    push(page); // 情形 A:API 与页面同目录(静态部署在站点根)
    push(joinUrl(page, '/..')); // 情形 B:页面在下一级目录(服务端模式 /public/)
    push(''); // 情形 C:相对当前文档(理论上与 A 等价,兜底)
    push('/'); // 情形 D:站点根
  }

  // 依次探测,第一个返回 ok:true 的即被采用
  for (const baseUrl of candidates) {
    const url = joinUrl(baseUrl, HEALTH_PATH);
    info.tried.push(url);
    info.url = url;

    let timer = null;
    try {
      const ac = typeof AbortController === 'function' ? new AbortController() : null;
      const timeoutError = new Promise((_, reject) => {
        timer = setTimeout(() => {
          const err = new Error(`探测 ${HEALTH_PATH} 超时(${timeoutMs}ms)`);
          err.name = 'TimeoutError';
          reject(err);
        }, timeoutMs);
      });
      const probe = (async () => {
        const res = await fetchImpl(url, {
          method: 'GET',
          headers: { accept: 'application/json' },
          cache: 'no-store',
          signal: ac ? ac.signal : undefined,
        });
        if (!res || !res.ok) {
          const err = new Error(`健康检查返回 ${res ? res.status : 'null'}`);
          err.name = 'HealthError';
          err.status = res ? res.status : 0;
          throw err;
        }
        let data = null;
        try {
          data = await res.json();
        } catch {
          data = null;
        }
        if (!data || data.ok !== true) {
          const err = new Error('健康检查未返回 ok:true');
          err.name = 'HealthError';
          throw err;
        }
        return data;
      })();

      const data = await Promise.race([probe, timeoutError]);
      info.ok = true;
      info.kind = 'server';
      info.reason = 'ok';
      info.version = data.version ?? null;
      info.serverKind = data.kind ?? null;
      const s = createServerStore(baseUrl, { ...(opts.server || {}), fetchImpl });
      s.probe = info;
      s.version = data.version ?? null;
      return s;
    } catch (err) {
      const name = err && err.name;
      // 超时是明确的失败,不必再试其它候选(网络本来就不通,继续试只会更久)
      if (name === 'TimeoutError') return useLocal('timeout', err);
      const status = err && err.status;
      info.lastReason = name === 'HealthError' ? (status ? `http-${status}` : 'health-not-ok') : 'fetch-error';
      info.lastError = String((err && err.message) || err);
      // 换下一个候选继续
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  return useLocal(info.lastReason || 'fetch-error', info.lastError ? new Error(info.lastError) : undefined);
}
