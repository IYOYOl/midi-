/**
 * api.js — 本地↔服务端同步(模块 C,契约见 INTERFACE.md 第 4 节)
 *
 * 职责(「刷新不清空」是这个项目的头号硬指标):
 *  1. 订阅 state,任何改动 → debounceMs(默认 300)后自动保存;
 *  2. **即时镜像**:改动发生的同一 tick 内同步写 localStorage(midi2srt:mirror:<projectId>),
 *     专门堵「300ms 防抖窗口内正好刷新」这道窄缝 —— 浏览器不保证 beforeunload 里的异步请求发得出去;
 *  3. visibilitychange(hidden)/ pagehide → 立刻 flush,不等防抖;
 *  4. beforeunload → 仍脏则 e.preventDefault() 拦一道;
 *  5. 保存失败 → 状态置 error/offline + localStorage 备份 + 每 3s 重试,绝不静默丢;
 *  6. onStatus({ state:'saved'|'saving'|'dirty'|'error'|'offline', revision, at }) 诚实反映状态。
 *
 * 可在 Node 下 import:document / window / localStorage 全部做了存在性判断,且都可注入(opts)。
 */

import { KEY_BACKUP, KEY_LAST_PROJECT, KEY_MIRROR, clone, resolveStorage } from './store.js';

export const DRAFT_ID = '__draft__';
export const MIRROR_PREFIX = KEY_MIRROR;
export const BACKUP_PREFIX = KEY_BACKUP;

/* ------------------------------------------------------------------ *
 * 镜像 / 备份(localStorage,同步读写)
 * ------------------------------------------------------------------ */

export function mirrorKey(projectId) {
  return KEY_MIRROR + (projectId || DRAFT_ID);
}

export function backupKey(projectId) {
  return KEY_BACKUP + (projectId || DRAFT_ID);
}

function defaultStorage() {
  return resolveStorage();
}

/** 同步写镜像。返回写入的镜像对象(写不进去返回 null,但绝不抛) */
export function writeMirror(project, storage = defaultStorage(), extra = {}) {
  if (!project || typeof project !== 'object') return null;
  const payload = {
    at: Date.now(),
    revision: Number.isFinite(Number(project.revision)) ? Number(project.revision) : 0,
    projectId: project.id || null,
    // dirty=true 表示「这份镜像里有尚未成功保存到服务端的编辑」。
    // 光比 revision 不够:防抖窗口内刷新时,镜像的 revision 与服务端相同,但内容更新。
    dirty: false,
    project: clone(project),
    ...extra,
  };
  try {
    storage.setItem(mirrorKey(project.id), JSON.stringify(payload));
    return payload;
  } catch {
    return null;
  }
}

/** 读镜像:返回 { at, revision, project } 或 null(损坏也返回 null,不抛) */
export function readMirror(projectId, storage = defaultStorage()) {
  try {
    const raw = storage.getItem(mirrorKey(projectId));
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object') return null;
    if (data.project && typeof data.project === 'object') return data;
    if (Array.isArray(data.tracks)) return { at: 0, revision: Number(data.revision) || 0, project: data }; // 容错:裸项目
    return null;
  } catch {
    return null;
  }
}

export function clearMirror(projectId, storage = defaultStorage()) {
  try {
    storage.removeItem(mirrorKey(projectId));
  } catch {
    /* 忽略 */
  }
}

/** 失败时的额外备份(带错误原因,便于排查) */
export function writeBackup(project, error, storage = defaultStorage()) {
  try {
    storage.setItem(
      backupKey(project && project.id),
      JSON.stringify({ at: Date.now(), error: String(error ?? ''), project: clone(project) }),
    );
  } catch {
    /* 忽略 */
  }
}

export function readBackup(projectId, storage = defaultStorage()) {
  try {
    const raw = storage.getItem(backupKey(projectId));
    if (!raw) return null;
    const data = JSON.parse(raw);
    return data && data.project ? data : null;
  } catch {
    return null;
  }
}

export function readLastProjectId(storage = defaultStorage()) {
  try {
    return storage.getItem(KEY_LAST_PROJECT) || null;
  } catch {
    return null;
  }
}

export function writeLastProjectId(id, storage = defaultStorage()) {
  try {
    if (id) storage.setItem(KEY_LAST_PROJECT, String(id));
    else storage.removeItem(KEY_LAST_PROJECT);
  } catch {
    /* 忽略 */
  }
}

/** 本机所有镜像 id(启动时找不到 lastProjectId 也能兜底恢复) */
export function listMirrorIds(storage = defaultStorage()) {
  const out = [];
  try {
    if (typeof storage.key !== 'function' || typeof storage.length !== 'number') return out;
    for (let i = 0; i < storage.length; i += 1) {
      const k = storage.key(i);
      if (k && k.startsWith(KEY_MIRROR)) out.push(k.slice(KEY_MIRROR.length));
    }
  } catch {
    /* 忽略 */
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * createSync
 * ------------------------------------------------------------------ */

export function createSync(state, store, opts = {}) {
  if (!state) throw new Error('createSync 需要 state');
  if (!store) throw new Error('createSync 需要 store');

  const debounceMs = Number.isFinite(opts.debounceMs) ? Math.max(0, opts.debounceMs) : 300;
  const retryMs = Number.isFinite(opts.retryMs) ? Math.max(0, opts.retryMs) : 3000;
  const onStatus = typeof opts.onStatus === 'function' ? opts.onStatus : null;
  const storage = opts.storage !== undefined ? opts.storage : defaultStorage();
  const doc = opts.document !== undefined ? opts.document : typeof document !== 'undefined' ? document : null;
  const win = opts.window !== undefined ? opts.window : typeof window !== 'undefined' ? window : null;
  const autoStart = opts.autoStart !== false;

  let statusState = 'saved';
  let revision = projectRevision();
  let at = Date.now();
  let lastError = null;
  let retries = 0;

  let pending = false; // 有尚未保存成功的改动
  let changeSeq = 0; // 改动序号:用来发现「保存期间用户又改了」
  let timer = null;
  let retryTimer = null;
  let inFlight = null;
  let unsubscribe = null;
  let started = false;
  let stopped = false;
  let suppress = false; // 应用服务端返回值/markClean 期间不要把自己的通知当新改动
  let destroyed = false;

  function projectRevision() {
    const p = state && state.project;
    const n = p && Number(p.revision);
    return Number.isFinite(n) ? n : 0;
  }

  function statusObj() {
    return {
      state: statusState,
      revision,
      at,
      mode: store.kind, // 'server' | 'local'
      retries,
      error: lastError ? String(lastError.message || lastError) : null,
    };
  }

  function setStatus(next, patch = {}) {
    statusState = next;
    at = Date.now();
    if (Object.prototype.hasOwnProperty.call(patch, 'revision')) revision = patch.revision;
    if (Object.prototype.hasOwnProperty.call(patch, 'error')) lastError = patch.error;
    const snap = statusObj();
    if (onStatus) {
      try {
        onStatus(snap);
      } catch {
        /* UI 报错不影响保存 */
      }
    }
    return snap;
  }

  function isDirtyNow() {
    if (pending) return true;
    try {
      return typeof state.isDirty === 'function' ? state.isDirty() === true : false;
    } catch {
      return false;
    }
  }

  /** 同步镜像:每次 mutation 后立即调用,不依赖任何定时器。dirty=true 表示这份镜像里有未回写服务端的编辑 */
  function mirrorNow(dirty = true) {
    if (!state.project) return;
    try {
      writeMirror(state.project, storage, { dirty: !!dirty });
    } catch {
      /* 镜像失败不影响主流程 */
    }
  }

  function clearTimer() {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function clearRetry() {
    if (retryTimer !== null) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
  }

  function schedule() {
    if (stopped || destroyed) return;
    clearTimer();
    timer = setTimeout(() => {
      timer = null;
      void flush();
    }, debounceMs);
  }

  function scheduleRetry() {
    if (stopped || destroyed || retryMs <= 0) return;
    clearRetry();
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void flush();
    }, retryMs);
  }

  /** state 通知入口:先写镜像(同步),再排防抖保存 */
  function noteChange() {
    if (destroyed) return;
    mirrorNow();
    if (suppress || stopped) return;
    changeSeq += 1;
    pending = true;
    if (statusState !== 'saving') setStatus('dirty');
    schedule();
  }

  function applySaved(saved, changedDuringSave) {
    if (!saved || !state.project) return;
    const p = state.project;
    suppress = true;
    try {
      if (saved.id) p.id = saved.id;
      if (Number.isFinite(Number(saved.revision))) p.revision = Number(saved.revision);
      if (Number.isFinite(Number(saved.updatedAt))) p.updatedAt = Number(saved.updatedAt);
      if (Number.isFinite(Number(saved.createdAt)) && !p.createdAt) p.createdAt = Number(saved.createdAt);
      if (!changedDuringSave) {
        // 只有「保存期间没有新改动」才允许清脏;否则保持脏,下面会再存一次,绝不丢编辑
        if (typeof state.markClean === 'function') state.markClean(p.revision);
        pending = false;
      }
    } finally {
      suppress = false;
    }
  }

  function doSave() {
    const run = (async () => {
      const project = state.project;
      if (!project) {
        pending = false;
        return setStatus('saved', { revision: projectRevision() });
      }
      mirrorNow(true); // 保存前再镜像一次(极端情况下 noteChange 没走到)
      setStatus('saving', { error: null });
      const snapshot = clone(project);
      const wasNew = !snapshot.id;
      const seqAtSave = changeSeq;
      let saved;
      try {
        saved = wasNew ? await store.createProject(snapshot) : await store.saveProject(snapshot);
      } catch (err) {
        lastError = err;
        retries += 1;
        // 保存失败 = 当前内容还没到服务端,必须保持脏,否则 3s 重试会因「看起来干净」而空转
        pending = true;
        writeBackup(state.project, err && err.message ? err.message : err, storage);
        mirrorNow(true);
        const offline = err && (err.offline === true || err.status === 0);

        // 409 是「别人在我之后也写过」,不是瞬时故障:基线不会自己变好,
        // 每 3 秒重试同一个过期基线只会永远失败。所以这里:
        //   ① 不排自动重试(否则就是无限空转)
        //   ② 丢掉本地记录的基准 revision,让**用户的下一次编辑**重新对齐服务端,
        //      从而能正常存下去 —— 既不让用户卡死,也不静默覆盖别人的改动
        //   ③ 状态标成 conflict,界面要明确告诉用户发生了什么
        if (err && err.status === 409) {
          try {
            if (typeof store.forgetRevision === 'function' && state.project && state.project.id) {
              store.forgetRevision(state.project.id);
            }
          } catch {
            /* 忽略:拿不到基线也要继续把冲突暴露出去 */
          }
          setStatus('conflict', { error: err, revision: projectRevision() });
          return statusObj();
        }

        setStatus(offline ? 'offline' : 'error', { error: err, revision: projectRevision() });
        scheduleRetry();
        return statusObj();
      }
      retries = 0;
      applySaved(saved, changeSeq !== seqAtSave);
      // 草稿镜像搬到真实 id 下,并补一次镜像(此刻项目已有 id/revision)
      if (wasNew && saved && saved.id) clearMirror(DRAFT_ID, storage);
      const changedDuring = changeSeq !== seqAtSave;
      mirrorNow(changedDuring); // 存成功后镜像标 dirty=false;若保存途中又有改动则仍为 dirty
      const rev = projectRevision();
      if (isDirtyNow()) {
        // 保存期间用户又改了:不能丢,立刻再存一次
        setStatus('dirty', { revision: rev });
        schedule();
      } else {
        setStatus('saved', { revision: rev, error: null });
      }
      return statusObj();
    })();

    const tracked = run.then(
      (v) => {
        if (inFlight === tracked) inFlight = null;
        return v;
      },
      (err) => {
        if (inFlight === tracked) inFlight = null;
        // doSave 内部已处理错误;这里只兜底,绝不把异常抛给 beforeunload 之类的调用点
        setStatus('error', { error: err });
        return statusObj();
      },
    );
    inFlight = tracked;
    return tracked;
  }

  /**
   * 立即保存(不等防抖),用于「立即保存」按钮与离开页面前的强制落盘。
   * 永远 resolve 成状态对象,不 reject —— 调用点(beforeunload/pagehide)不能有未捕获异常。
   */
  async function flush(options = {}) {
    clearTimer();
    if (inFlight) await inFlight.catch(() => {});
    const force = options.force === true;
    if (!state.project) return statusObj();
    if (!force && !isDirtyNow()) return statusObj();
    if (inFlight) await inFlight.catch(() => {});
    return doSave();
  }

  /* ---------------- 生命周期事件 ---------------- */

  function onVisibilityChange() {
    const hidden = !!doc && (doc.visibilityState === 'hidden' || doc.hidden === true);
    if (hidden) void flush();
  }

  function onPageHide() {
    void flush();
  }

  function onBeforeUnload(e) {
    if (!isDirtyNow()) return undefined;
    void flush(); // 尽力而为:同步镜像才是这一道的主力保险
    if (e) {
      e.preventDefault();
      e.returnValue = '';
      return '';
    }
    return undefined;
  }

  function bindEvents() {
    try {
      if (doc && typeof doc.addEventListener === 'function') {
        doc.addEventListener('visibilitychange', onVisibilityChange);
      }
      if (win && typeof win.addEventListener === 'function') {
        win.addEventListener('pagehide', onPageHide);
        win.addEventListener('beforeunload', onBeforeUnload);
      } else if (!win && doc && typeof doc.addEventListener === 'function') {
        doc.addEventListener('pagehide', onPageHide);
      }
    } catch {
      /* 忽略 */
    }
  }

  function unbindEvents() {
    try {
      if (doc && typeof doc.removeEventListener === 'function') {
        doc.removeEventListener('visibilitychange', onVisibilityChange);
      }
      if (win && typeof win.removeEventListener === 'function') {
        win.removeEventListener('pagehide', onPageHide);
        win.removeEventListener('beforeunload', onBeforeUnload);
      }
    } catch {
      /* 忽略 */
    }
  }

  function start() {
    if (destroyed) return api;
    stopped = false;
    if (started) return api;
    started = true;
    if (typeof state.subscribe === 'function') unsubscribe = state.subscribe(() => noteChange());
    bindEvents();
    if (isDirtyNow()) {
      setStatus('dirty');
      schedule();
    } else {
      setStatus('saved', { revision: projectRevision() });
    }
    return api;
  }

  function stop() {
    stopped = true;
    started = false;
    clearTimer();
    clearRetry();
    if (unsubscribe) {
      try {
        unsubscribe();
      } catch {
        /* 忽略 */
      }
      unsubscribe = null;
    }
    unbindEvents();
    return api;
  }

  /**
   * 采用了外部(服务端/镜像)加载来的项目后调用:
   * 重置脏标记与定时器,避免「刚打开就回存一次」的无意义 revision+1。
   */
  function adopt(project) {
    const p = project || (state && state.project);
    suppress = true;
    try {
      pending = false;
      clearTimer();
      clearRetry();
      retries = 0;
      lastError = null;
      revision = p && Number.isFinite(Number(p.revision)) ? Number(p.revision) : 0;
      if (typeof state.markClean === 'function') state.markClean(revision); // 刚打开=与磁盘一致,不该回存
      writeLastProjectId(p && p.id, storage);
      if (p && p.id) clearMirror(DRAFT_ID, storage);
    } finally {
      suppress = false;
    }
    if (p) {
      try {
        writeMirror(p, storage, { dirty: false });
      } catch {
        /* 忽略 */
      }
    }
    setStatus('saved', { revision, error: null });
    return api;
  }

  function destroy() {
    stop();
    destroyed = true;
  }

  const api = {
    flush,
    start,
    stop,
    status: statusObj,
    noteChange,
    adopt,
    destroy,
    mirrorNow,
    isDirtyNow,
    get store() {
      return store;
    },
    get state() {
      return state;
    },
  };

  if (autoStart) start();
  return api;
}

export default createSync;
