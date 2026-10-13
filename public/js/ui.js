/**
 * ui.js — 界面外壳装配(模块 C,契约见 INTERFACE.md 第 4 节)
 *
 * 职责:工具栏 / 轨道面板 / 属性面板 / 状态栏 / 对话框 / 导入导出接线 /
 *       启动恢复(服务端优先,镜像兜底并明确提示)。
 *
 * 关于协作边界:
 *  - 模块 B 的 state.js / render_timeline.js / interact.js 用**动态 import**。
 *    它们还没就绪时,外壳不会白屏:用一个内置的最小 state(同签名)+ 列表模式继续跑通
 *    「改 → 存 → 刷新恢复」这条链路;模块 B 一旦就位,自动切到 canvas 时间轴。
 *  - 所有对模型的修改都走 state 的 mutator(见 INTERFACE.md 第 3 节),不直接改 segments。
 */

import { detectStore, createLocalStore } from './store.js';
import {
  createSync,
  readMirror,
  readLastProjectId,
  writeLastProjectId,
  listMirrorIds,
  DRAFT_ID,
} from './api.js';
import {
  ensureCore,
  readMidiFile,
  midiToProject,
  newProjectObject,
  SETTINGS_DEFAULTS,
} from './importers.js';
import { ensureExporterCore, exporterStatus, exportFormats, buildExport, download } from './exporter.js';

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

const $ = (id) => document.getElementById(id);

function h(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v == null) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'html') node.innerHTML = v; // 只用于静态模板,绝不插入用户数据
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of [].concat(children)) {
    if (c == null) continue;
    node.append(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

function pad(n, len = 2) {
  return String(n).padStart(len, '0');
}

/** 毫秒 → mm:ss.mmm(超过 1 小时补小时) */
export function formatMs(ms) {
  const v = Math.max(0, Math.round(Number(ms) || 0));
  const hh = Math.floor(v / 3600000);
  const mm = Math.floor((v % 3600000) / 60000);
  const ss = Math.floor((v % 60000) / 1000);
  const mmm = v % 1000;
  return `${hh ? `${hh}:` : ''}${hh ? pad(mm) : pad(mm)}:${pad(ss)}.${pad(mmm, 3)}`;
}

/** 兼容三种写法:纯数字=毫秒、mm:ss.mmm、h:mm:ss.mmm(也接受 , 作小数分隔) */
export function parseTimeInput(text, fallbackMs = 0) {
  if (typeof text === 'number') return Math.round(text);
  const s = String(text ?? '').trim();
  if (!s) return fallbackMs;
  if (/^-?\d+(?:\.\d+)?$/.test(s)) return Math.round(Number(s));
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?$/.exec(s);
  if (m) {
    const hh = Number(m[1] || 0);
    const mm = Number(m[2]);
    const ss = Number(m[3]);
    const frac = (m[4] || '').padEnd(3, '0');
    return (((hh * 60 + mm) * 60 + ss) * 1000) + Number(frac || 0);
  }
  const m2 = /^(\d{1,3})(?:[.,](\d{1,3}))?$/.exec(s);
  if (m2) return Number(m2[1]) * 1000 + Number((m2[2] || '').padEnd(3, '0') || 0);
  return NaN;
}

function fmtClock(epochMs) {
  if (!epochMs) return '—';
  const d = new Date(epochMs);
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function countSegments(project) {
  if (!project || !Array.isArray(project.tracks)) return 0;
  return project.tracks.reduce((n, t) => n + (Array.isArray(t.segments) ? t.segments.length : 0), 0);
}

function trackOf(state, trackId) {
  const tracks = state.project && Array.isArray(state.project.tracks) ? state.project.tracks : [];
  return tracks.find((t) => t.id === trackId) || null;
}

/* ------------------------------------------------------------------ *
 * 应用状态
 * ------------------------------------------------------------------ */

const app = {
  store: null,
  state: null,
  sync: null,
  timeline: null,
  mode: 'list', // 'timeline' | 'list'
  fallbackState: false,
  renderQueued: false,
  unsubscribe: null,
  banners: new Map(),
  saveStatus: { state: 'saved', revision: 0, mode: 'server' },
};

const els = {};

/* ------------------------------------------------------------------ *
 * 提示:横幅 / toast / 模态框
 * ------------------------------------------------------------------ */

function showBanner(level, text, { id = 'default', sticky = false, action = null, priority = 0 } = {}) {
  if (!els.banner) return;
  app.banners.set(id, { level, text, sticky, action, priority });
  paintBanner();
}

function hideBanner(id = 'default') {
  app.banners.delete(id);
  paintBanner();
}

function paintBanner() {
  if (!els.banner) return;
  els.banner.textContent = '';
  if (!app.banners.size) {
    els.banner.hidden = true;
    return;
  }
  // 一次只显示最重要的一条:error > warn > ok > info;同级看 priority,再按加入顺序
  const rank = { error: 3, warn: 2, ok: 1, info: 0 };
  const [id, item] = [...app.banners.entries()].sort(
    (a, b) => rank[b[1].level] - rank[a[1].level] || (b[1].priority || 0) - (a[1].priority || 0),
  )[0];
  els.banner.hidden = false;
  els.banner.dataset.level = item.level;
  els.banner.append(h('span', { class: 'banner__text', text: item.text }));
  if (app.banners.size > 1) {
    els.banner.append(h('span', { class: 'badge', text: `+${app.banners.size - 1}` }));
  }
  if (typeof item.action === 'object' && item.action) {
    els.banner.append(
      h('button', {
        class: 'ghost',
        text: item.action.label,
        onclick: () => {
          try {
            item.action.onClick();
          } catch (err) {
            console.error(err);
          }
        },
      }),
    );
  }
  if (!item.sticky) {
    els.banner.append(h('button', { class: 'ghost icon', text: '✕', title: '关闭', onclick: () => hideBanner(id) }));
  }
}

let toastTimer = null;
function showToast(text, ms = 2200) {
  if (!els.toast) return;
  els.toast.textContent = text;
  els.toast.hidden = false;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    els.toast.hidden = true;
  }, ms);
}

function closeModal() {
  if (!els.modalRoot) return;
  els.modalRoot.hidden = true;
  els.modalRoot.textContent = '';
}

function openModal({ title, body, actions = [], onClose = null }) {
  closeModal();
  const modal = h('div', { class: 'modal', role: 'dialog', 'aria-label': title });
  modal.append(
    h('div', { class: 'modal__head' }, [
      h('span', { text: title }),
      h('button', { class: 'ghost icon', text: '✕', title: '关闭', onclick: () => { closeModal(); if (onClose) onClose(); } }),
    ]),
  );
  const bodyEl = h('div', { class: 'modal__body' });
  if (typeof body === 'string') bodyEl.textContent = body;
  else if (body) bodyEl.append(body);
  modal.append(bodyEl);
  if (actions.length) {
    const foot = h('div', { class: 'modal__foot' });
    for (const a of actions) {
      foot.append(
        h('button', {
          class: a.primary ? 'primary' : a.danger ? 'danger' : '',
          text: a.label,
          onclick: () => a.onClick({ close: closeModal }),
        }),
      );
    }
    modal.append(foot);
  }
  els.modalRoot.hidden = false;
  els.modalRoot.append(modal);
  const focusable = modal.querySelector('input, textarea, button');
  if (focusable) setTimeout(() => focusable.focus(), 0);
  return modal;
}

function promptDialog(title, label, value = '') {
  return new Promise((resolve) => {
    const input = h('input', { type: 'text', value, 'data-field': 'prompt' });
    const wrap = h('div', {}, [h('div', { class: 'panel__section-title', text: label }), input]);
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      closeModal();
      resolve(v);
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') done(input.value.trim() || null);
      if (e.key === 'Escape') done(null);
    });
    openModal({
      title,
      body: wrap,
      actions: [
        { label: '取消', onClick: () => done(null) },
        { label: '确定', primary: true, onClick: () => done(input.value.trim() || null) },
      ],
      onClose: () => done(null),
    });
  });
}

function confirmDialog(title, text) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      closeModal();
      resolve(v);
    };
    openModal({
      title,
      body: text,
      actions: [
        { label: '取消', onClick: () => done(false) },
        { label: '确定', danger: true, primary: true, onClick: () => done(true) },
      ],
      onClose: () => done(false),
    });
  });
}

/* ------------------------------------------------------------------ *
 * 状态(state):优先模块 B,缺省用内置最小实现
 * ------------------------------------------------------------------ */

function createFallbackState() {
  const state = {
    project: null,
    selection: { trackId: null, segmentIds: [] },
    view: { pxPerMs: 0.08, scrollMs: 0, laneHeight: 44, playheadMs: 0 },
    dirty: false,
    fallback: true,
  };
  const listeners = new Set();
  const LIMIT = 100;
  let undoStack = [];
  let redoStack = [];

  const cloneTracks = () => JSON.parse(JSON.stringify((state.project && state.project.tracks) || []));
  const track = (id) => ((state.project && state.project.tracks) || []).find((t) => t.id === id) || null;
  const writable = (id) => {
    const t = track(id);
    return t && !t.locked ? t : null;
  };
  const minDur = () => Number(state.project?.settings?.minDurationMs) || SETTINGS_DEFAULTS.minDurationMs;

  function snapshot() {
    if (!state.project) return;
    undoStack.push(cloneTracks());
    if (undoStack.length > LIMIT) undoStack.shift();
    redoStack = [];
  }
  function notify() {
    state.dirty = true;
    for (const fn of [...listeners]) fn(state);
  }
  function normalizeSegs(segs) {
    const arr = (segs || []).map((s) => ({ ...s }));
    arr.sort((a, b) => a.startMs - b.startMs);
    for (const s of arr) {
      s.startMs = Math.max(0, Math.round(Number(s.startMs) || 0));
      s.endMs = Math.round(Number(s.endMs) || 0);
      if (!(s.endMs > s.startMs)) s.endMs = s.startMs + minDur();
    }
    for (let i = 1; i < arr.length; i += 1) {
      if (arr[i].startMs < arr[i - 1].endMs) arr[i].startMs = arr[i - 1].endMs;
      if (!(arr[i].endMs > arr[i].startMs)) arr[i].endMs = arr[i].startMs + minDur();
    }
    return arr;
  }
  function nextSegId() {
    let max = 0;
    for (const t of (state.project && state.project.tracks) || []) {
      for (const s of t.segments || []) {
        const m = /^s_(\d+)$/.exec(s.id || '');
        if (m) max = Math.max(max, Number(m[1]));
      }
    }
    return `s_${max + 1}`;
  }
  function recomputeDuration() {
    if (!state.project) return 0;
    let max = 0;
    for (const t of state.project.tracks || []) for (const s of t.segments || []) max = Math.max(max, Number(s.endMs) || 0);
    state.project.durationMs = max;
    return max;
  }

  return {
    ...state,
    get project() {
      return state.project;
    },
    set project(v) {
      state.project = v;
    },
    get selection() {
      return state.selection;
    },
    set selection(v) {
      state.selection = v;
    },
    get view() {
      return state.view;
    },
    get dirty() {
      return state.dirty;
    },

    setProject(project) {
      state.project = project;
      state.dirty = false;
      state.selection = { trackId: (project?.tracks?.[0]?.id) ?? null, segmentIds: [] };
    },

    setSegments(trackId, segments) {
      const t = writable(trackId);
      if (!t) return;
      snapshot();
      t.segments = normalizeSegs(segments);
      recomputeDuration();
      notify();
    },
    updateSegment(trackId, segmentId, patch = {}) {
      const t = writable(trackId);
      if (!t) return;
      const s = (t.segments || []).find((x) => x.id === segmentId);
      if (!s) return;
      snapshot();
      Object.assign(s, patch);
      t.segments = normalizeSegs(t.segments);
      recomputeDuration();
      notify();
    },
    addSegment(trackId, segment) {
      const t = writable(trackId);
      if (!t) return;
      snapshot();
      const seg = { id: segment?.id || nextSegId(), startMs: 0, endMs: 0, text: '', kind: 'lyric', source: null, words: null, ...segment };
      seg.id = segment?.id || seg.id || nextSegId();
      if (!/^s_\d+$/.test(seg.id)) seg.id = nextSegId();
      t.segments = normalizeSegs([...(t.segments || []), seg]);
      recomputeDuration();
      notify();
    },
    removeSegments(trackId, ids) {
      const t = writable(trackId);
      if (!t) return;
      const set = new Set([].concat(ids || []));
      snapshot();
      t.segments = (t.segments || []).filter((s) => !set.has(s.id));
      state.selection.segmentIds = state.selection.segmentIds.filter((id) => !set.has(id));
      recomputeDuration();
      notify();
    },
    splitSegmentAt(trackId, segmentId, atMs) {
      const t = writable(trackId);
      if (!t) return;
      const s = (t.segments || []).find((x) => x.id === segmentId);
      if (!s) return;
      const at = Math.round(Number(atMs));
      if (!(at > s.startMs && at < s.endMs)) return;
      snapshot();
      const left = { ...s, endMs: at, words: null };
      const right = { ...s, id: nextSegId(), startMs: at, words: null };
      t.segments = normalizeSegs([...(t.segments || []).filter((x) => x.id !== segmentId), left, right]);
      state.selection.segmentIds = [left.id];
      recomputeDuration();
      notify();
    },
    mergeWithNext(trackId, segmentId) {
      const t = writable(trackId);
      if (!t) return;
      const list = (t.segments || []).slice().sort((a, b) => a.startMs - b.startMs);
      const i = list.findIndex((x) => x.id === segmentId);
      if (i < 0 || i === list.length - 1) return;
      const a = list[i];
      const b = list[i + 1];
      snapshot();
      const merged = { ...a, endMs: Math.max(a.endMs, b.endMs), text: `${a.text || ''}${b.text || ''}`, words: null, source: a.source || b.source || null };
      t.segments = normalizeSegs([...list.filter((x) => x.id !== a.id && x.id !== b.id), merged]);
      state.selection.segmentIds = [merged.id];
      recomputeDuration();
      notify();
    },
    shiftTrack(trackId, offsetMs) {
      const t = writable(trackId);
      if (!t || !Number.isFinite(Number(offsetMs)) || !Number(offsetMs)) return;
      snapshot();
      const off = Math.round(Number(offsetMs));
      let shifted = (t.segments || []).map((s) => ({ ...s, startMs: Math.max(0, s.startMs + off), endMs: Math.max(0, s.endMs + off) }));
      if (off < 0) {
        const min = Math.min(...shifted.map((s) => s.startMs));
        if (min < 0) shifted = shifted.map((s) => ({ ...s, startMs: s.startMs - min, endMs: s.endMs - min }));
      }
      t.segments = normalizeSegs(shifted);
      recomputeDuration();
      notify();
    },
    shiftAll(offsetMs) {
      if (!state.project || !Number.isFinite(Number(offsetMs)) || !Number(offsetMs)) return;
      snapshot();
      const off = Math.round(Number(offsetMs));
      const all = [];
      for (const t of state.project.tracks || []) for (const s of t.segments || []) all.push(s.startMs + off);
      const min = all.length ? Math.min(...all) : 0;
      const delta = min < 0 ? off - min : off;
      for (const t of state.project.tracks || []) {
        if (t.locked) continue;
        t.segments = normalizeSegs((t.segments || []).map((s) => ({ ...s, startMs: s.startMs + delta, endMs: s.endMs + delta })));
      }
      recomputeDuration();
      notify();
    },
    regroup(settingsPatch) {
      if (!state.project) return;
      snapshot();
      state.project.settings = { ...(state.project.settings || {}), ...(settingsPatch || {}) };
      notify();
    },
    setTrackFlag(trackId, flag, value) {
      const t = track(trackId);
      if (!t) return;
      snapshot();
      t[flag] = !!value;
      notify();
    },
    setTrackName(trackId, name) {
      const t = track(trackId);
      if (!t) return;
      snapshot();
      t.name = String(name ?? '').trim() || t.name;
      notify();
    },
    select(trackId, segmentIds = [], mode = 'replace') {
      const ids = [].concat(segmentIds || []);
      const cur = state.selection;
      if (mode === 'add' || mode === 'toggle') {
        const sameTrack = cur.trackId === trackId;
        const base = sameTrack ? cur.segmentIds.slice() : [];
        for (const id of ids) {
          const i = base.indexOf(id);
          if (mode === 'toggle' && i >= 0) base.splice(i, 1);
          else if (i < 0) base.push(id);
        }
        state.selection = { trackId, segmentIds: base };
      } else {
        state.selection = { trackId, segmentIds: ids };
      }
      for (const fn of [...listeners]) fn(state);
    },
    setView(patch) {
      Object.assign(state.view, patch || {});
      for (const fn of [...listeners]) fn(state);
    },

    undo() {
      if (!undoStack.length || !state.project) return;
      redoStack.push(cloneTracks());
      state.project.tracks = undoStack.pop();
      recomputeDuration();
      notify();
    },
    redo() {
      if (!redoStack.length || !state.project) return;
      undoStack.push(cloneTracks());
      state.project.tracks = redoStack.pop();
      recomputeDuration();
      notify();
    },
    canUndo() {
      return undoStack.length > 0;
    },
    canRedo() {
      return redoStack.length > 0;
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    isDirty() {
      return state.dirty === true;
    },
    markClean(revision) {
      state.dirty = false;
      if (state.project && Number.isFinite(Number(revision))) state.project.revision = Number(revision);
    },
  };
}

async function createState(store) {
  try {
    const mod = await import('./state.js');
    if (typeof mod.createAppState === 'function') {
      const s = mod.createAppState(store);
      if (s && typeof s.subscribe === 'function') return s;
      throw new Error('createAppState 返回值不符合 AppState 约定');
    }
    throw new Error('state.js 未导出 createAppState');
  } catch (err) {
    app.fallbackState = true;
    console.warn('[ui] 模块 B 的 state.js 尚未就绪,使用内置最小 state 兜底:', err && err.message ? err.message : err);
    return createFallbackState();
  }
}

/** 把外部(服务端/镜像/快照)加载来的项目放进 state */
function applyProject(project) {
  const s = app.state;
  if (!project) return;
  if (typeof s.setProject === 'function') s.setProject(project);
  else if (typeof s.loadProject === 'function') s.loadProject(project);
  else s.project = project;
  if (typeof s.select === 'function') {
    try {
      s.select(project.tracks?.[0]?.id ?? null, [], 'replace');
    } catch {
      /* 忽略 */
    }
  }
  if (typeof s.markClean === 'function') {
    try {
      s.markClean(Number(project.revision) || 0);
    } catch {
      /* 忽略 */
    }
  }
  writeLastProjectId(project.id || null);
}

/* ------------------------------------------------------------------ *
 * 渲染
 * ------------------------------------------------------------------ */

function queueRender() {
  if (app.renderQueued) return;
  app.renderQueued = true;
  const run = () => {
    app.renderQueued = false;
    renderAll();
  };
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
  else setTimeout(run, 16);
}

function renderAll() {
  renderToolbar();
  renderStageToolbar();
  renderTracks();
  renderProps();
  renderStatusBar();
  if (app.mode === 'list') renderFallbackLanes();
  if (app.timeline && typeof app.timeline.render === 'function') {
    try {
      app.timeline.render();
    } catch (err) {
      console.error('[ui] timeline.render 失败:', err);
    }
  }
  // 必须放在 timeline.render() 之后:滚动条要读 render 后确定的 metrics
  syncScrollbars();
}

function renderToolbar() {
  const project = app.state.project;
  const nameInput = els.projectName;
  if (nameInput && document.activeElement !== nameInput) {
    nameInput.value = project ? project.name || '' : '';
    nameInput.placeholder = project ? '' : '未命名项目';
    nameInput.disabled = !project;
  }
  const undoBtn = els.toolbar.querySelector('[data-act="undo"]');
  const redoBtn = els.toolbar.querySelector('[data-act="redo"]');
  const hasUndo = typeof app.state.canUndo === 'function' ? !!app.state.canUndo() : false;
  const hasRedo = typeof app.state.canRedo === 'function' ? !!app.state.canRedo() : false;
  if (undoBtn) undoBtn.disabled = !hasUndo;
  if (redoBtn) redoBtn.disabled = !hasRedo;
  const exp = els.toolbar.querySelector('[data-act="export"]');
  if (exp) exp.disabled = !project;
  const hist = els.toolbar.querySelector('[data-act="history"]');
  if (hist) hist.disabled = !project || !project.id;
  if (els.saveNow) els.saveNow.disabled = !project;
}

function renderStageToolbar() {
  if (!els.stageToolbar) return;
  const view = app.state.view || {};
  els.stageToolbar.textContent = '';
  els.stageToolbar.append(
    h('span', { class: 'muted', text: '缩放' }),
    h('button', { class: 'ghost icon', text: '−', title: '缩小', onclick: () => zoomBy(1 / 1.25) }),
    h('span', { class: 'mono', text: `${Math.round((Number(view.pxPerMs) || 0) * 1000)} px/s` }),
    h('button', { class: 'ghost icon', text: '＋', title: '放大', onclick: () => zoomBy(1.25) }),
    h('button', {
      class: 'ghost',
      text: '适配',
      title: '缩放并回到起点,让整条时间轴刚好铺满视口(看不到末尾时按这个)',
      onclick: () => fitTimelineToView(),
    }),
    h('button', {
      class: 'ghost',
      text: '开头',
      title: '回到时间轴起点(Home)',
      onclick: () => app.state.setView({ scrollMs: 0 }),
    }),
    h('span', { class: 'toolbar__sep' }),
    h('span', {
      class: 'badge',
      text: app.mode === 'timeline' ? '时间轴模式' : '列表模式(时间轴模块未就绪)',
      title: app.mode === 'timeline' ? '模块 B 的 canvas 时间轴已接管' : '模块 B 就绪后自动切换;数据、保存、刷新恢复完全一致',
    }),
  );
  const project = app.state.project;
  if (project && app.mode === 'list') {
    const sealed = (project.tracks || []).find((t) => !t.locked) || project.tracks?.[0];
    if (sealed) {
      els.stageToolbar.append(
        h('button', {
          class: '',
          text: '＋ 添加片段',
          title: '在末尾追加一个 1 秒片段',
          onclick: () => addSegmentAtEnd(sealed.id),
        }),
      );
    }
  }
  if (app.fallbackState) {
    els.stageToolbar.append(h('span', { class: 'muted', text: '内置最小 state(模块 B 未就绪)' }));
  }
}

function zoomBy(factor) {
  const view = app.state.view || { pxPerMs: 0.08 };
  const next = Math.min(4, Math.max(0.002, (Number(view.pxPerMs) || 0.08) * factor));
  if (typeof app.state.setView === 'function') app.state.setView({ pxPerMs: next });
  else queueRender();
}

/**
 * 把某条轨的泳道滚进视口。
 * 纵向只滚 canvas 的 view.scrollY(不是整个页面)—— 时间轴自己实现滚动。
 */
function revealLaneFor(trackId) {
  const tl = app.timeline;
  const p = app.state.project;
  if (!tl || typeof tl.metrics !== 'function' || !p) return;
  // 面板与 canvas 都只列可见轨,所以序号要在「可见轨」里数
  const visible = p.tracks.filter((t) => t.visible !== false);
  const idx = visible.findIndex((t) => t.id === trackId);
  if (idx < 0) return;
  const m = tl.metrics();
  if (!m || !m.height) return;
  const laneH = m.laneH || 48;
  const gap = m.laneGap || 6;
  const rulerH = m.rulerH || 28;
  // 视口里能放几条泳道
  const laneCount = Math.max(1, Math.floor((m.height - rulerH) / (laneH + gap)));
  const scrollY = idx < laneCount ? 0 : (idx - laneCount + 1) * (laneH + gap);
  app.state.setView({ scrollY });
}

/* ------------------------------------------------------------------ *
 * 时间轴滚动条
 *
 * canvas 是自己实现滚动的(不靠 overflow),所以滚动条得手动画。
 * 没有它的话:一条 33 秒的歌词在 50px/s 下是 1700px 宽,视口只有 800 多,
 * 用户完全不知道右边还有内容 —— 这正是「没有滑动条」的成因。
 *
 * 实现上有一条**必须避开**的坑:滚动条不能占 canvas 的布局宽度。
 * 因为它一占,canvas 就变窄 → metrics 变 → 滚动条再变 → 无限 resize 循环。
 * 所以这里用 position:absolute 覆盖在 canvas 上,尺寸只由 view 和 metrics 决定。
 * ------------------------------------------------------------------ */

/** 内容末尾之后多留一段可滚区间,否则最后一个片段贴着右边缘没法编辑 */
const TIMELINE_TAIL_MS = 2000;

function timelineMetrics() {
  const tl = app.timeline;
  if (!tl || typeof tl.metrics !== 'function') return null;
  try {
    return tl.metrics();
  } catch {
    return null;
  }
}

function maxScrollMsOf(m) {
  const p = app.state.project;
  const dur = Number(p && p.durationMs) || 0;
  const contentMs = Math.max(dur, m.scrollMs + m.width / m.pxPerMs) + TIMELINE_TAIL_MS;
  return Math.max(0, contentMs - m.width / m.pxPerMs);
}

function syncScrollbars() {
  const hbar = els.hbar;
  const vbar = els.vbar;
  if (!hbar || !vbar) return;
  const m = timelineMetrics();
  if (!m || !m.width || !m.height) {
    hbar.hidden = true;
    vbar.hidden = true;
    return;
  }

  // 滑块尺寸由 CSS 决定(横向:高度贴合槽、宽度=长度;纵向:宽度贴合槽、高度=长度),
  // JS 只负责**位置**。这样不会出现"JS 设了尺寸、CSS 的锚定方向又把它从另一头挤出去"
  // 这类几何打架 —— 实测踩过(min-width 24px 配 right:0 会让滑块从左侧溢出槽外)。

  // —— 横向 ——
  const viewMs = m.width / m.pxPerMs;
  const maxMs = maxScrollMsOf(m);
  const contentMs = viewMs + maxMs;
  hbar.hidden = maxMs <= 0;
  if (maxMs > 0) {
    const ratio = Math.min(1, viewMs / contentMs);
    const trackW = hbar.clientWidth;
    const thumbW = Math.max(28, Math.round(trackW * ratio));
    const travel = Math.max(0, trackW - thumbW);
    const frac = Math.min(1, Math.max(0, m.scrollMs / maxMs));
    els.hbarThumb.style.width = `${thumbW}px`;
    els.hbarThumb.style.transform = `translateX(${Math.round(travel * frac)}px)`;
    hbar.title = `时间轴:${formatMs(m.scrollMs)} – ${formatMs(m.scrollMs + viewMs)}(共 ${formatMs(contentMs)});拖动或按住 Shift 滚轮`;
  }

  // —— 纵向 ——
  const viewH = m.height;
  const contentH = m.contentHeight;
  const maxY = Math.max(0, contentH - viewH);
  vbar.hidden = maxY <= 0;
  if (maxY > 0) {
    const ratio = Math.min(1, viewH / contentH);
    const trackH = vbar.clientHeight;
    const thumbH = Math.max(28, Math.round(trackH * ratio));
    const travel = Math.max(0, trackH - thumbH);
    const frac = Math.min(1, Math.max(0, (m.scrollY || 0) / maxY));
    els.vbarThumb.style.height = `${thumbH}px`;
    els.vbarThumb.style.transform = `translateY(${Math.round(travel * frac)}px)`;
    vbar.title = `泳道 ${Math.round(m.scrollY || 0)} / ${contentH} px;拖动或按住 Shift 滚轮`;
  }
}

/** 绑定一条滚动条的拖拽。axis: 'x' | 'y' */
function attachScrollbarDrag(barEl, thumbEl, axis) {
  if (!barEl || !thumbEl) return;
  /** @type {{startPos:number, startThumb:number, travel:number, trackLen:number, maxScroll:number}|null} */
  let drag = null;

  const posOf = (e) => (axis === 'x' ? e.clientX : e.clientY);

  thumbEl.addEventListener('pointerdown', (e) => {
    const m = timelineMetrics();
    if (!m) return;
    e.preventDefault();
    e.stopPropagation();
    const rect = barEl.getBoundingClientRect();
    const thumbRect = thumbEl.getBoundingClientRect();
    const trackLen = axis === 'x' ? rect.width : rect.height;
    const thumbLen = axis === 'x' ? thumbRect.width : thumbRect.height;
    const maxScroll = axis === 'x' ? maxScrollMsOf(m) : Math.max(0, m.contentHeight - m.height);
    drag = {
      startPos: posOf(e),
      startThumb: axis === 'x' ? m.scrollMs : m.scrollY || 0,
      travel: Math.max(1, trackLen - thumbLen),
      maxScroll,
    };
    try {
      thumbEl.setPointerCapture(e.pointerId);
    } catch {
      /* 某些环境下不支持,靠 window 监听兜底 */
    }
  });

  thumbEl.addEventListener('pointermove', (e) => {
    if (!drag) return;
    e.preventDefault();
    const delta = posOf(e) - drag.startPos;
    const next = drag.startThumb + (delta / drag.travel) * drag.maxScroll;
    const clamped = Math.max(0, Math.min(drag.maxScroll, next));
    if (axis === 'x') app.state.setView({ scrollMs: Math.round(clamped) });
    else app.state.setView({ scrollY: Math.round(clamped) });
  });

  const endDrag = (e) => {
    if (!drag) return;
    drag = null;
    try {
      thumbEl.releasePointerCapture(e.pointerId);
    } catch {
      /* 忽略 */
    }
  };
  thumbEl.addEventListener('pointerup', endDrag);
  thumbEl.addEventListener('pointercancel', endDrag);

  // 点空白轨道 = 翻一页,不用非得抓住滑块
  barEl.addEventListener('pointerdown', (e) => {
    if (e.target === thumbEl) return;
    const m = timelineMetrics();
    if (!m) return;
    const rect = barEl.getBoundingClientRect();
    const p = posOf(e) - (axis === 'x' ? rect.left : rect.top);
    const len = axis === 'x' ? rect.width : rect.height;
    if (axis === 'x') {
      const maxScroll = maxScrollMsOf(m);
      const viewMs = m.width / m.pxPerMs;
      const next = Math.max(0, Math.min(maxScroll, m.scrollMs + (p < len / 2 ? -viewMs * 0.8 : viewMs * 0.8)));
      app.state.setView({ scrollMs: Math.round(next) });
    } else {
      const maxScroll = Math.max(0, m.contentHeight - m.height);
      const next = Math.max(0, Math.min(maxScroll, (m.scrollY || 0) + (p < len / 2 ? -m.height * 0.8 : m.height * 0.8)));
      app.state.setView({ scrollY: Math.round(next) });
    }
  });
}

/** 「适配」:把缩放调到刚好装下整条时间轴,并回到起点 */
function fitTimelineToView() {
  const m = timelineMetrics();
  if (!m || !m.width) return;
  const p = app.state.project;
  // 用「项目时长」和「最后一段的结束时间」里更大的那个。
  // 只信 durationMs 会被空项目(0)和 durationMs 没同步的项目坑到 ——
  // 那会让"适配"算出个没用的缩放。
  const fromSegments = (p && Array.isArray(p.tracks) ? p.tracks : []).reduce((max, t) => {
    for (const s of t.segments || []) {
      const e = Number(s.endMs);
      if (Number.isFinite(e) && e > max) max = e;
    }
    return max;
  }, 0);
  const declared = Number(p && p.durationMs) || 0;
  const contentMs = Math.max(declared, fromSegments, 1000) + TIMELINE_TAIL_MS;
  const pxPerMs = m.width / contentMs;
  const min = 0.0002;
  const max = 4;
  app.state.setView({
    pxPerMs: Math.max(min, Math.min(max, pxPerMs)),
    scrollMs: 0,
    scrollY: 0,
  });
}

function renderTracks() {
  if (!els.trackList) return;
  const project = app.state.project;
  els.trackList.textContent = '';
  const allTracks = project && Array.isArray(project.tracks) ? project.tracks : [];
  const hiddenCount = allTracks.filter((t) => t.visible === false).length;
  if (els.trackCount) {
    els.trackCount.textContent = project
      ? `${allTracks.length} 轨${hiddenCount ? ` · 隐藏 ${hiddenCount}` : ''}`
      : '';
  }

  // 「新建轨道」按钮常驻在面板顶部:没有项目时禁用并说明原因,
  // 有项目时随时可用 —— 否则空项目(0 轨)就是个死路,永远加不了轨。
  if (els.trackPanelHead) {
    els.trackPanelHead.textContent = '';
    const addBtn = h('button', {
      class: 'ghost track-add',
      text: '＋ 新建轨道',
      title: project ? '在当前项目里新增一条空轨道' : '先「新建」或「导入 MIDI」,才能加轨道',
    });
    addBtn.disabled = !project;
    addBtn.addEventListener('click', () => {
      const id = app.state.addTrack?.();
      if (id) {
        if (typeof app.state.select === 'function') app.state.select(id, [], 'replace');
        // 新轨在列表末尾,滚到底让用户看得见它 —— 否则轨多了会以为"没建上"
        if (els.trackList) els.trackList.scrollTop = els.trackList.scrollHeight;
        revealLaneFor(id);
      }
      queueRender();
    });
    els.trackPanelHead.append(
      h('span', { class: 'panel__title', text: '轨道' }),
      els.trackCount,
      addBtn,
    );
  }

  if (!allTracks.length) {
    els.trackList.append(
      h('div', { class: 'empty', text: project ? '这个项目还没有轨道。点上面的「＋ 新建轨道」加一条。' : '还没有项目。点「新建」或「导入 MIDI」开始。' }),
    );
    return;
  }
  const activeTrackId = app.state.selection?.trackId;

  /**
   * 轨道卡片。
   *
   * 注意:时间轴的 canvas 只为**可见轨**排泳道(render_timeline.js 的 visibleTracks()),
   * 所以面板里可见轨的先后顺序必须与之一致,否则取消可见后泳道整体上移、
   * DOM 行不动,点到的行和看到的泳道就对不上了。
   * 不可见轨因此被挪到面板底部的折叠区,而不是留在原位,也不是直接 display:none
   * —— 后者会把「可见」勾选框一起藏掉,用户就再也无法把轨道恢复出来了。
   */
  function trackCard(track) {
    const nameInput = h('input', {
      class: 'track__name',
      type: 'text',
      value: track.name || '',
      'data-field': `track-name-${track.id}`,
      title: '双击/直接修改轨道名',
    });
    nameInput.addEventListener('change', () => {
      if (typeof app.state.setTrackName === 'function') app.state.setTrackName(track.id, nameInput.value);
      queueRender();
    });
    nameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') nameInput.blur();
    });

    const visible = h('input', { type: 'checkbox', checked: track.visible !== false });
    visible.addEventListener('change', () => app.state.setTrackFlag?.(track.id, 'visible', visible.checked));
    const locked = h('input', { type: 'checkbox', checked: track.locked === true });
    locked.addEventListener('change', () => app.state.setTrackFlag?.(track.id, 'locked', locked.checked));

    // 轨道的上下移与删除:没有删除入口的话「新建轨道」点错了就没法收拾
    const upBtn = h('button', {
      class: 'ghost icon track__op',
      text: '↑',
      title: '轨道上移一位',
      onclick: (e) => {
        e.stopPropagation();
        app.state.moveTrack?.(track.id, -1);
        queueRender();
      },
    });
    const downBtn = h('button', {
      class: 'ghost icon track__op',
      text: '↓',
      title: '轨道下移一位',
      onclick: (e) => {
        e.stopPropagation();
        app.state.moveTrack?.(track.id, 1);
        queueRender();
      },
    });
    const delBtn = h('button', {
      class: 'ghost icon track__op track__op--danger',
      text: '✕',
      title: '删除这条轨道(连同它的片段);可用 Ctrl+Z 撤销',
      onclick: async (e) => {
        e.stopPropagation();
        const n = (track.segments || []).length;
        // 有片段的轨删起来代价大,确认一下;空轨直接删(反正能撤销)
        if (n > 0) {
          const ok = await confirmDialog(
            '删除轨道',
            `「${track.name || '未命名轨道'}」里有 ${n} 个片段,删除后可以按 Ctrl+Z 撤销。确定删除吗?`,
          );
          if (!ok) return;
        }
        app.state.removeTrack?.(track.id);
        queueRender();
      },
    });

    const card = h('div', {
      class: 'track',
      dataset: { active: String(track.id === activeTrackId), locked: String(track.locked === true) },
      onclick: (e) => {
        if (e.target.closest('input, button')) return;
        app.state.select?.(track.id, [], 'replace');
      },
    });
    card.append(
      h('div', { class: 'track__top' }, [nameInput, upBtn, downBtn, delBtn]),
      h('div', { class: 'track__flags' }, [
        h('label', {}, [visible, '可见']),
        h('label', {}, [locked, '锁定']),
        h('span', { class: 'track__count', text: `${(track.segments || []).length} 段` }),
      ]),
    );
    return card;
  }

  // 顺序必须与 canvas 泳道一致:只列可见轨,按原顺序
  for (const track of allTracks) {
    if (track.visible === false) continue;
    els.trackList.append(trackCard(track));
  }

  // 不可见轨单独收在底部,便于随时恢复
  const hiddenTracks = allTracks.filter((t) => t.visible === false);
  if (hiddenTracks.length) {
    const box = h('details', { class: 'track-group' });
    box.append(
      h('summary', {
        class: 'track-group__head',
        text: `已被隐藏的轨道(${hiddenTracks.length}) — 与时间轴不显示,勾选「可见」可恢复`,
      }),
    );
    for (const track of hiddenTracks) box.append(trackCard(track));
    els.trackList.append(box);
  }
}

function renderProps() {
  if (!els.propsList) return;
  const active = document.activeElement;
  const focusKey = active && els.propsList.contains(active) ? active.dataset.field : null;
  let selStart = null;
  let selEnd = null;
  try {
    selStart = active && active.selectionStart;
    selEnd = active && active.selectionEnd;
  } catch {
    /* 某些类型没有 selectionStart */
  }

  els.propsList.textContent = '';
  const project = app.state.project;
  const sel = app.state.selection || { trackId: null, segmentIds: [] };
  const track = trackOf(app.state, sel.trackId);
  const segs = track ? (track.segments || []).filter((s) => (sel.segmentIds || []).includes(s.id)) : [];

  if (!project) {
    els.propsList.append(h('div', { class: 'empty', text: '没有打开的项目。' }));
    if (els.propsHint) els.propsHint.textContent = '';
    return;
  }
  if (!segs.length) {
    if (els.propsHint) els.propsHint.textContent = '';
    els.propsList.append(
      h('div', { class: 'empty' }, [
        h('div', { text: '未选中片段。' }),
        h('div', { class: 'hint', text: app.mode === 'timeline' ? '在时间轴上点选片段;Shift/Ctrl 多选。' : '在下方列表里点选片段。' }),
      ]),
    );
    renderProjectSettings();
    return;
  }

  if (els.propsHint) els.propsHint.textContent = `${segs.length} 个`;
  if (segs.length === 1) renderSegmentEditor(track, segs[0]);
  else renderBatchEditor(track, segs);

  if (focusKey) {
    const next = els.propsList.querySelector(`[data-field="${focusKey}"]`);
    if (next) {
      next.focus();
      try {
        next.setSelectionRange(selStart, selEnd);
      } catch {
        /* 忽略 */
      }
    }
  }
}

/** 提交一次字段修改(时间/文本/类型) */
function commitSegmentPatch(track, seg, patch) {
  const locked = track.locked === true;
  if (locked) {
    showToast('该轨道已锁定,先解锁再改');
    return;
  }
  if (typeof app.state.updateSegment !== 'function') return;
  app.state.updateSegment(track.id, seg.id, patch);
  const after = trackOf(app.state, track.id)?.segments?.find((s) => s.id === seg.id);
  if (after && !(after.endMs > after.startMs) && typeof app.state.updateSegment === 'function') {
    app.state.updateSegment(track.id, seg.id, { endMs: after.startMs + (Number(app.state.project?.settings?.minDurationMs) || 200) });
  }
  queueRender();
}

function renderSegmentEditor(track, seg) {
  const minDur = Number(app.state.project?.settings?.minDurationMs) || SETTINGS_DEFAULTS.minDurationMs;
  const startInput = h('input', {
    type: 'text',
    class: 'mono',
    value: formatMs(seg.startMs),
    'data-field': 'seg-start',
    title: '支持 毫秒 或 mm:ss.mmm',
  });
  startInput.addEventListener('change', () => {
    const ms = parseTimeInput(startInput.value, seg.startMs);
    if (!Number.isFinite(ms)) {
      showToast(`无法识别的时间:${startInput.value}(可用 20786 或 00:20.786)`);
      startInput.value = formatMs(seg.startMs);
      return;
    }
    commitSegmentPatch(track, seg, { startMs: Math.max(0, Math.round(ms)) });
  });

  const endInput = h('input', {
    type: 'text',
    class: 'mono',
    value: formatMs(seg.endMs),
    'data-field': 'seg-end',
    title: '支持 毫秒 或 mm:ss.mmm',
  });
  endInput.addEventListener('change', () => {
    const ms = parseTimeInput(endInput.value, seg.endMs);
    if (!Number.isFinite(ms)) {
      showToast(`无法识别的时间:${endInput.value}(可用 21286 或 00:21.286)`);
      endInput.value = formatMs(seg.endMs);
      return;
    }
    commitSegmentPatch(track, seg, { endMs: Math.round(ms) });
  });

  const textArea = h('textarea', { 'data-field': 'seg-text', rows: 3 });
  textArea.value = seg.text ?? '';
  textArea.addEventListener('change', () => commitSegmentPatch(track, seg, { text: textArea.value }));

  const kindSel = h('select', { 'data-field': 'seg-kind' });
  kindSel.append(
    h('option', { value: 'lyric', text: 'lyric(子字幕,会被导出)' }),
    h('option', { value: 'meta', text: 'meta(仅参考,默认不导出)' }),
  );
  kindSel.value = seg.kind === 'meta' ? 'meta' : 'lyric';
  kindSel.addEventListener('change', () => commitSegmentPatch(track, seg, { kind: kindSel.value }));

  const playhead = Number(app.state.view?.playheadMs) || 0;
  const atMs = playhead > seg.startMs && playhead < seg.endMs ? playhead : Math.round((seg.startMs + seg.endMs) / 2);

  els.propsList.append(
    h('div', { class: 'seg-head' }, [
      h('span', { class: 'badge', text: seg.kind === 'meta' ? 'meta' : 'lyric' }),
      h('span', { class: 'seg-head__id', text: `${seg.id} @ ${track.name || track.id}` }),
    ]),
    h('div', { class: 'field' }, [h('span', { text: '开始' }), startInput]),
    h('div', { class: 'field' }, [h('span', { text: '结束' }), endInput]),
    h('div', { class: 'field' }, [h('span', { text: '时长' }), h('span', { class: 'mono muted', text: `${seg.endMs - seg.startMs} ms` })]),
    h('div', { class: 'panel__section-title', text: '文本' }),
    textArea,
    h('div', { class: 'field', style: 'margin-top:8px' }, [h('span', { text: '类型' }), kindSel]),
    h('div', { class: 'row row--wrap', style: 'margin-top:8px' }, [
      h('button', {
        text: '拆分',
        title: `在 ${formatMs(atMs)} 拆成两条`,
        onclick: () => {
          app.state.splitSegmentAt?.(track.id, seg.id, atMs);
          queueRender();
        },
      }),
      h('button', {
        text: '合并下一个',
        onclick: () => {
          app.state.mergeWithNext?.(track.id, seg.id);
          queueRender();
        },
      }),
      h('button', {
        class: 'danger',
        text: '删除',
        onclick: () => {
          app.state.removeSegments?.(track.id, [seg.id]);
          queueRender();
        },
      }),
    ]),
    h('div', { class: 'hint', text: `最短时长 ${minDur}ms 会被自动补齐;endMs ≤ startMs 一律自动修正。` }),
    seg.source && Number.isFinite(Number(seg.source.tick))
      ? h('div', { class: 'hint', text: `原始 MIDI 位置:tick ${seg.source.tick} · 轨 ${seg.source.trackIndex ?? '?'}` })
      : null,
    renderShiftControls(track, [seg]),
  );
}

function renderShiftControls(track, segs) {
  const input = h('input', { type: 'text', class: 'mono', value: '+100', 'data-field': 'shift-ms', title: '可正可负,单位毫秒' });
  const apply = (scope) => {
    const ms = parseTimeInput(input.value, NaN);
    if (!Number.isFinite(ms) || !ms) {
      showToast('请输入非 0 的毫秒偏移,例如 100 或 -50');
      return;
    }
    if (scope === 'all') app.state.shiftAll?.(ms);
    else if (scope === 'track') app.state.shiftTrack?.(track.id, ms);
    else if (segs.length && typeof app.state.updateSegment === 'function') {
      for (const s of segs) {
        app.state.updateSegment(track.id, s.id, { startMs: Math.max(0, s.startMs + ms), endMs: Math.max(0, s.endMs + ms) });
      }
    }
    queueRender();
  };
  return h('div', { class: 'panel__section' }, [
    h('div', { class: 'panel__section-title', text: '批量偏移' }),
    h('div', { class: 'field' }, [h('span', { text: '偏移量' }), input]),
    h('div', { class: 'row row--wrap' }, [
      h('button', { text: '本轨', onclick: () => apply('track') }),
      h('button', { text: '全部', onclick: () => apply('all') }),
      segs.length > 1 ? h('button', { text: '选中', onclick: () => apply('selection') }) : null,
    ].filter(Boolean)),
  ]);
}

function renderBatchEditor(track, segs) {
  const list = h('div', { class: 'selected-list' });
  for (const s of segs.slice(0, 50)) {
    list.append(
      h('div', { class: 'selected-row' }, [
        h('span', { class: 'mono muted', text: `${formatMs(s.startMs)}` }),
        h('span', { class: 'grow', text: s.text || '(空)' }),
      ]),
    );
  }
  els.propsList.append(
    h('div', { class: 'seg-head' }, [h('span', { class: 'badge', text: `已选 ${segs.length} 段` }), h('span', { class: 'seg-head__id', text: track.name || track.id })]),
    list,
    h('div', { class: 'row row--wrap', style: 'margin-top:8px' }, [
      h('button', {
        class: 'danger',
        text: '删除所选',
        onclick: () => {
          app.state.removeSegments?.(track.id, segs.map((s) => s.id));
          queueRender();
        },
      }),
      h('button', {
        text: '清空选择',
        onclick: () => {
          app.state.select?.(track.id, [], 'replace');
          queueRender();
        },
      }),
    ]),
    renderShiftControls(track, segs),
  );
}

function renderProjectSettings() {
  const project = app.state.project;
  if (!project) return;
  const settings = project.settings || {};
  const gap = h('input', { type: 'text', class: 'mono', value: String(settings.gapMs ?? ''), 'data-field': 'set-gap' });
  gap.addEventListener('change', () => {
    const v = parseTimeInput(gap.value, NaN);
    if (!Number.isFinite(v)) return;
    app.state.regroup?.({ gapMs: Math.round(v) });
    queueRender();
  });
  els.propsList.append(
    h('div', { class: 'panel__section' }, [
      h('div', { class: 'panel__section-title', text: '项目' }),
      h('div', { class: 'field' }, [h('span', { text: '名称' }), h('span', { text: project.name || '未命名' })]),
      h('div', { class: 'field' }, [h('span', { text: '总长' }), h('span', { class: 'mono', text: formatMs(project.durationMs) })]),
      h('div', { class: 'field' }, [h('span', { text: '断句阈值' }), gap]),
      project.midi
        ? h('div', { class: 'hint', text: `MIDI:${project.midi.fileName || '—'} · ppq ${project.midi.ppq ?? '?'} · tempo ${project.midi.tempoCount ?? '?'} 处` })
        : null,
    ]),
  );
}

function renderFallbackLanes() {
  if (!els.timelineFallback) return;
  const project = app.state.project;
  els.timelineFallback.textContent = '';
  if (!project) {
    els.timelineFallback.append(
      h('div', { class: 'empty' }, [
        h('div', { text: '还没有打开项目。' }),
        h('div', { class: 'hint', text: '顶部「新建」建一个空项目,或「导入 MIDI」把 .mid 转成字幕片段。' }),
      ]),
    );
    return;
  }
  const sel = app.state.selection || {};
  els.timelineFallback.append(
    h('div', { class: 'hint', text: '列表模式(模块 B 的 canvas 时间轴就绪后自动切换)。点选片段后在右侧改起止时间。' }),
  );
  for (const track of project.tracks || []) {
    const lane = h('div', { class: 'lane' });
    lane.append(
      h('div', { class: 'lane__head' }, [
        h('b', { text: track.name || track.id }),
        h('span', { class: 'muted', text: `${(track.segments || []).length} 段` }),
        track.visible === false ? h('span', { class: 'badge', text: '不可见' }) : null,
        track.locked ? h('span', { class: 'badge', text: '已锁定' }) : null,
      ]),
    );
    const chips = h('div', { class: 'chips' });
    for (const s of (track.segments || []).slice().sort((a, b) => a.startMs - b.startMs)) {
      const selected = sel.trackId === track.id && (sel.segmentIds || []).includes(s.id);
      const chip = h('div', {
        class: 'chip',
        dataset: { selected: String(selected), kind: s.kind === 'meta' ? 'meta' : 'lyric' },
        title: `${s.id} · ${formatMs(s.startMs)} → ${formatMs(s.endMs)}`,
        onclick: (e) => {
          const mode = e.shiftKey || e.ctrlKey || e.metaKey ? 'toggle' : 'replace';
          app.state.select?.(track.id, [s.id], mode);
          queueRender();
        },
      });
      chip.append(
        h('span', { class: 'chip__time', text: formatMs(s.startMs) }),
        h('span', { class: 'chip__text', text: s.text || '(空)' }),
      );
      chips.append(chip);
    }
    if (!(track.segments || []).length) chips.append(h('span', { class: 'muted', text: '(空轨道)' }));
    lane.append(chips);
    els.timelineFallback.append(lane);
  }
}

function renderStatusBar() {
  if (!els.statusbar) return;
  const project = app.state.project;
  const view = app.state.view || {};
  const segs = app.state.selection?.segmentIds || [];
  const st = app.saveStatus || { state: 'saved' };
  els.statusbar.textContent = '';
  const item = (k, v, cls = '') => h('span', { class: 'statusbar__item' }, [h('span', { class: 'statusbar__k', text: k }), h('span', { class: `statusbar__v ${cls}`, text: v })]);

  els.statusbar.append(item('缩放', `${Math.round((Number(view.pxPerMs) || 0) * 1000)} px/s`));
  els.statusbar.append(item('总长', formatMs(project?.durationMs || 0)));
  els.statusbar.append(item('片段', String(countSegments(project))));
  els.statusbar.append(item('选中', String(segs.length)));
  els.statusbar.append(h('span', { class: 'statusbar__spacer' }));
  els.statusbar.append(item('存储', app.store?.kind === 'server' ? '服务端' : '本地存储', app.store?.kind === 'server' ? 'is-accent' : 'is-warn'));
  els.statusbar.append(item('版本', `r${project?.revision ?? 0}`));
  const statusText =
    { saved: '已保存', saving: '保存中…', dirty: '未保存', error: '保存失败', offline: '离线(待重试)', conflict: '版本冲突' }[
      st.state
    ] || st.state;
  const cls =
    { saved: 'is-ok', saving: 'is-accent', dirty: 'is-warn', error: 'is-err', offline: 'is-offline', conflict: 'is-err' }[
      st.state
    ] || '';
  els.statusbar.append(item('状态', statusText, cls));
  if (st.mode === 'local') els.statusbar.append(h('span', { class: 'badge', text: '静态/本地模式' }));
  if (app.fallbackState) els.statusbar.append(h('span', { class: 'badge', text: '最小 state 兜底' }));
}

function paintStatus(status) {
  app.saveStatus = status;
  if (els.saveLight) {
    els.saveLight.dataset.state = status.state;
    const label = els.saveLight.querySelector('.light__label');
    const text =
      { saved: '已保存', saving: '保存中…', dirty: '未保存', error: '保存失败', offline: '离线', conflict: '版本冲突' }[
        status.state
      ] || status.state;
    if (label) label.textContent = status.error ? `${text}:${String(status.error).slice(0, 40)}` : text;
    els.saveLight.title = [
      `状态:${text}`,
      `版本:r${status.revision ?? 0}`,
      `存储:${status.mode === 'server' ? '服务端' : '本地存储'}`,
      status.retries ? `已重试 ${status.retries} 次` : '',
      status.error ? `错误:${status.error}` : '',
    ]
      .filter(Boolean)
      .join('\n');
  }
  renderStatusBar();
}

/** 同步状态 → 界面:状态灯 + 横幅(失败必须显眼,恢复后要撤掉) */
function onSyncStatus(status) {
  paintStatus(status);
  const storeLabel = () => (app.store && app.store.kind === 'server' ? '服务端' : '本地存储');
  if (status.state === 'conflict') {
    // 409:别的窗口/别人在这之后也写过这个项目。绝不静默覆盖,也绝不假装保存成功。
    // 基线已经重新对齐,用户下一次编辑就能正常存下去。
    showBanner(
      'error',
      `版本冲突:这个项目在别处也被改过(服务端已是更新的一版),本次改动没有覆盖对方。` +
        `你的改动仍完整保存在本地镜像和备份里,不会丢 —— 再编辑一下即可基于最新版保存,` +
        `或先用「历史」把对方那一版打开看看。`,
      { id: 'save-fail', sticky: true, priority: 6 },
    );
    return;
  }
  if (status.state === 'error' || status.state === 'offline') {
    showBanner('error', `${status.state === 'offline' ? '离线:无法连接' : '保存失败:'}${status.error || ''}。改动已即时写入本地镜像并留了备份,每 3 秒自动重试,不会丢。`, {
      id: 'save-fail',
      sticky: true,
      priority: 5,
    });
    return;
  }
  if (status.state === 'saved') {
    if (app.banners.has('save-fail')) hideBanner('save-fail');
    if (app.recoveryWriteFailed) {
      app.recoveryWriteFailed = false;
      showBanner('ok', `本地镜像已回写${storeLabel()}(r${status.revision})。`, { id: 'recover', priority: 10 });
      setTimeout(() => hideBanner('recover'), 6000);
    }
  }
}

/* ------------------------------------------------------------------ *
 * 项目操作
 * ------------------------------------------------------------------ */

async function newProject() {
  try {
    const project = newProjectObject('未命名项目', app.state.project?.settings);
    const created = await app.store.createProject(project); // 立刻上服务端/本地存储:刷新不丢
    applyProject(created);
    app.sync.adopt(created);
    renderAll();
    showToast('已新建项目(立即落盘,可放心刷新)');
    if (els.projectName) {
      els.projectName.focus();
      els.projectName.select();
    }
  } catch (err) {
    showBanner('error', `新建失败:${err.message}`, { id: 'op' });
  }
}

async function openProject(id) {
  try {
    const project = await app.store.loadProject(id);
    applyProject(project);
    app.sync.adopt(project);
    renderAll();
    closeModal();
    showBanner('ok', `已打开「${project.name}」(r${project.revision})`, { id: 'op' });
  } catch (err) {
    showBanner('error', `打开失败:${err.message}`, { id: 'op' });
  }
}

async function importMidiFile(file) {
  if (!file) return;
  try {
    showToast(`正在解析 ${file.name} …`, 8000);
    await ensureCore();
    const { buf, name } = await readMidiFile(file);
    const project = midiToProject(buf, name, app.state.project?.settings);
    const created = await app.store.createProject(project);
    applyProject(created);
    app.sync.adopt(created);
    renderAll();
    const tempoCount = Number(created.midi?.tempoCount) || 0;
    showBanner(
      'ok',
      `已导入「${name}」:${(created.tracks || []).length} 轨 / ${countSegments(created)} 个片段` +
        (tempoCount > 1 ? `(已按 tempo map 分段换算,共 ${tempoCount} 处 tempo 变更)` : ''),
      { id: 'op' },
    );
  } catch (err) {
    showBanner('error', `导入失败:${err.message}`, { id: 'op' });
  } finally {
    if (els.fileInput) els.fileInput.value = '';
  }
}

function addSegmentAtEnd(trackId) {
  const track = trackOf(app.state, trackId);
  if (!track) return;
  if (track.locked) {
    showToast('该轨道已锁定');
    return;
  }
  const segs = track.segments || [];
  const last = segs.reduce((m, s) => Math.max(m, Number(s.endMs) || 0), 0);
  const start = segs.length ? last + 100 : 1000;
  app.state.addSegment?.(trackId, {
    startMs: start,
    endMs: start + 1000,
    text: '新片段',
    kind: 'lyric',
    source: null,
    words: null,
  });
  const added = (trackOf(app.state, trackId)?.segments || []).slice(-1)[0];
  if (added) app.state.select?.(trackId, [added.id], 'replace');
  queueRender();
}

async function renameCurrentProject(name) {
  const project = app.state.project;
  if (!project || !name || name === project.name) return;
  project.name = String(name).trim() || project.name;
  app.sync.noteChange(); // 标脏 + 立刻镜像 + 防抖保存
  renderAll();
}

/* ------------------------------------------------------------------ *
 * 对话框
 * ------------------------------------------------------------------ */

async function openProjectsDialog() {
  const body = h('div', { class: 'list' });
  let rows = [];
  try {
    rows = await app.store.listProjects();
  } catch (err) {
    body.append(h('div', { class: 'empty', text: `读取项目列表失败:${err.message}` }));
  }
  if (!rows.length) {
    body.append(
      h('div', { class: 'empty' }, [
        h('div', { text: '还没有任何项目。' }),
        h('div', { class: 'hint', text: app.store.kind === 'local' ? '当前是本地存储模式(静态部署):项目保存在这个浏览器的 localStorage 里。' : '点击「新建」或「导入 MIDI」创建第一个项目。' }),
      ]),
    );
  }
  for (const row of rows) {
    const item = h('div', { class: 'list__item' });
    item.append(
      h('div', { class: 'list__main' }, [
        h('div', { class: 'list__name', text: row.name || row.id }),
        h('div', {
          class: 'list__meta',
          text: `r${row.revision ?? '?'} · ${fmtClock(row.updatedAt)}` + (row.segmentCount != null ? ` · ${row.segmentCount} 段` : ''),
        }),
      ]),
      h('button', { class: 'primary', text: '打开', onclick: () => openProject(row.id) }),
      h('button', { text: '重命名', onclick: async () => {
          const name = await promptDialog('重命名项目', '新的项目名', row.name || '');
          if (!name) return;
          try {
            await app.store.renameProject(row.id, name);
            if (app.state.project && app.state.project.id === row.id) {
              app.state.project.name = name;
              app.sync.noteChange();
              renderAll();
            }
            showToast('已重命名');
            openProjectsDialog();
          } catch (err) {
            showBanner('error', `重命名失败:${err.message}`, { id: 'op' });
          }
        } }),
      h('button', { text: '历史', onclick: () => openHistoryDialog(row.id) }),
      h('button', {
        class: 'danger',
        text: '删除',
        onclick: async () => {
          const ok = await confirmDialog('删除项目', `确定删除「${row.name || row.id}」?该项目的全部快照也会一并删除。`);
          if (!ok) return;
          try {
            await app.store.deleteProject(row.id);
            if (app.state.project && app.state.project.id === row.id) {
              // 删掉的正是当前项目:切到最近的一个,没有就留个空项目(空项目不落盘,免得凭空多一条)
              const rest = await app.store.listProjects();
              if (rest.length) {
                const next = await app.store.loadProject(rest[0].id);
                applyProject(next);
                app.sync.adopt(next);
                showBanner('warn', `已删除「${row.name || row.id}」,已切换到「${next.name}」(r${next.revision})。`, { id: 'op' });
              } else {
                const blank = newProjectObject('未命名项目');
                applyProject(blank);
                app.sync.adopt(blank);
                showBanner('warn', `已删除「${row.name || row.id}」,当前没有项目:下一次编辑会自动新建并落盘。`, { id: 'op' });
              }
              renderAll();
            }
            showToast('已删除');
            openProjectsDialog();
          } catch (err) {
            showBanner('error', `删除失败:${err.message}`, { id: 'op' });
          }
        },
      }),
    );
    body.append(item);
  }
  openModal({
    title: '打开项目',
    body,
    actions: [{ label: '关闭', onClick: ({ close }) => close() }],
  });
}

async function openHistoryDialog(projectId) {
  const id = projectId || app.state.project?.id;
  const body = h('div', { class: 'list' });
  if (!id) {
    body.append(h('div', { class: 'empty', text: '当前项目还没有 id(先保存一次)。' }));
  } else {
    let rows = [];
    try {
      rows = await app.store.getHistory(id);
    } catch (err) {
      body.append(h('div', { class: 'empty', text: `读取历史失败:${err.message}` }));
    }
    if (!rows.length) body.append(h('div', { class: 'empty', text: '还没有历史快照。' }));
    for (const row of rows) {
      body.append(
        h('div', { class: 'list__item' }, [
          h('div', { class: 'list__main' }, [
            h('div', { class: 'list__name', text: `revision ${row.revision}` + (app.state.project && app.state.project.revision === row.revision ? '(当前)' : '') }),
            h('div', { class: 'list__meta', text: `${fmtClock(row.savedAt)} · ${row.bytes || 0} 字节` }),
          ]),
          h('button', {
            text: '恢复',
            onclick: async () => {
              const ok = await confirmDialog('恢复快照', `用 revision ${row.revision} 覆盖当前项目?当前内容会先存成一份新快照。`);
              if (!ok) return;
              try {
                await app.sync.flush({ force: true }); // 先把当前内容存下来,别丢
                const restored = await app.store.restoreRevision(id, row.revision);
                applyProject(restored);
                app.sync.adopt(restored);
                renderAll();
                closeModal();
                showBanner('ok', `已恢复到 revision ${row.revision}(现在是 r${restored.revision})`, { id: 'op' });
              } catch (err) {
                showBanner('error', `恢复失败:${err.message}`, { id: 'op' });
              }
            },
          }),
        ]),
      );
    }
  }
  openModal({ title: '历史快照', body, actions: [{ label: '关闭', onClick: ({ close }) => close() }] });
}

function openExportMenu(anchor) {
  document.querySelectorAll('.menu').forEach((m) => m.remove());
  const menu = h('div', { class: 'menu' });
  const formats = exportFormats();
  for (const f of formats) {
    menu.append(
      h('button', {
        text: `${f.label}${f.ext ? `  (${f.ext})` : ''}`,
        onclick: async () => {
          menu.remove();
          try {
            await ensureExporterCore();
            const built = buildExport(f.id, app.state.project, { includeHidden: false, includeMeta: false });
            download(built.text, built.filename, built.mime);
            showToast(`已导出 ${built.filename}(${built.text.length} 字符)`);
          } catch (err) {
            showBanner('error', `导出失败:${err.message}`, { id: 'op' });
          }
        },
      }),
    );
  }
  if (!exporterStatus().ready) {
    menu.append(h('div', { class: 'menu__sep' }));
    menu.append(h('div', { class: 'hint', style: 'padding:4px 8px', text: '导出模块(lib/exporters.mjs)加载中或未就绪' }));
  }
  const rect = anchor.getBoundingClientRect();
  menu.style.top = `${rect.bottom + 6}px`;
  menu.style.left = `${Math.max(8, rect.right - 190)}px`;
  document.body.append(menu);
  const close = (e) => {
    if (menu.contains(e.target)) return;
    menu.remove();
    document.removeEventListener('click', close, true);
  };
  setTimeout(() => document.addEventListener('click', close, true), 0);
}

/* ------------------------------------------------------------------ *
 * 启动:探测 store → 装配外壳 → 恢复上次项目 → 接时间轴
 * ------------------------------------------------------------------ */

function bindToolbar() {
  els.toolbar.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;
    if (act === 'new') newProject();
    else if (act === 'open') openProjectsDialog();
    else if (act === 'import') els.fileInput.click();
    else if (act === 'undo') {
      app.state.undo?.();
      queueRender();
    } else if (act === 'redo') {
      app.state.redo?.();
      queueRender();
    } else if (act === 'history') openHistoryDialog(app.state.project?.id);
    else if (act === 'export') openExportMenu(btn);
    else if (act === 'save') {
      app.sync
        .flush({ force: true })
        .then((st) => showToast(st.state === 'saved' ? `已保存(r${st.revision})` : `保存未成功:${st.error || st.state}`));
    }
  });

  els.projectName.addEventListener('change', () => renameCurrentProject(els.projectName.value));
  els.projectName.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') els.projectName.blur();
  });

  els.saveLight.addEventListener('click', () => {
    const st = app.saveStatus;
    showToast(
      {
        saved: `已保存到${st.mode === 'server' ? '服务端' : '本地存储'}(r${st.revision})`,
        saving: '正在保存…',
        dirty: '有改动待保存,点击「立即保存」',
        error: `保存失败:${st.error || ''}`,
        offline: '离线:改动已存在本地镜像,恢复连接后自动重试',
        conflict: '版本冲突:项目在别处也被改过。你的改动已保存在本地镜像,再编辑一下就会基于最新版保存',
      }[st.state] || st.state,
      4000,
    );
  });

  els.fileInput.addEventListener('change', () => importMidiFile(els.fileInput.files && els.fileInput.files[0]));

  // 列表模式下的键位兜底;时间轴模式交给模块 B 的 interact.js,避免一次按键撤销两次
  document.addEventListener('keydown', (e) => {
    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && e.key.toLowerCase() === 's') {
      e.preventDefault();
      app.sync.flush({ force: true }).then((st) => showToast(st.state === 'saved' ? `已保存(r${st.revision})` : `保存未成功:${st.error || st.state}`));
      return;
    }
    if (app.mode === 'timeline') return;
    const tag = (e.target && e.target.tagName) || '';
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(tag);
    if (ctrl && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (e.shiftKey) app.state.redo?.();
      else app.state.undo?.();
      queueRender();
    } else if (ctrl && e.key.toLowerCase() === 'y') {
      e.preventDefault();
      app.state.redo?.();
      queueRender();
    } else if (!typing && (e.key === 'Delete' || e.key === 'Backspace')) {
      const sel = app.state.selection;
      if (sel && sel.trackId && (sel.segmentIds || []).length) {
        e.preventDefault();
        app.state.removeSegments?.(sel.trackId, sel.segmentIds);
        queueRender();
      }
    } else if (!typing && (e.key === '+' || e.key === '=')) {
      zoomBy(1.25);
    } else if (!typing && e.key === '-') {
      zoomBy(1 / 1.25);
    }
  });

  const onResize = () => {
    if (app.timeline && typeof app.timeline.resize === 'function') app.timeline.resize();
    queueRender();
  };
  window.addEventListener('resize', onResize);
  if (typeof ResizeObserver === 'function' && els.timelineWrap) {
    try {
      new ResizeObserver(onResize).observe(els.timelineWrap);
    } catch {
      /* 忽略 */
    }
  }
}

function renderShell() {
  els.toolbar.textContent = '';
  els.toolbar.append(
    h('div', { class: 'toolbar__brand' }, [h('span', { text: 'MIDI' }), h('b', { text: '→' }), h('span', { text: '字幕' })]),
    h('div', { class: 'toolbar__group' }, [
      h('button', { 'data-act': 'new', text: '新建', title: '新建项目(立即落盘)' }),
      h('button', { 'data-act': 'open', text: '打开…', title: '打开已有项目' }),
      h('button', { 'data-act': 'import', text: '导入 MIDI', title: '选择 .mid 文件' }),
    ]),
    h('span', { class: 'toolbar__sep' }),
    h('label', { class: 'toolbar__group' }, [h('span', { class: 'muted', text: '项目名' }), els.projectName = h('input', { class: 'project-name', type: 'text', 'data-field': 'project-name' })]),
    h('span', { class: 'toolbar__sep' }),
    h('div', { class: 'toolbar__group' }, [
      h('button', { 'data-act': 'undo', text: '↶ 撤销', title: 'Ctrl+Z' }),
      h('button', { 'data-act': 'redo', text: '↷ 重做', title: 'Ctrl+Y' }),
    ]),
    h('span', { class: 'toolbar__spacer' }),
    h('div', { class: 'toolbar__group' }, [
      h('button', { 'data-act': 'history', text: '历史', title: '历史快照 / 恢复' }),
      h('button', { 'data-act': 'export', text: '导出 ▾', title: '导出 SRT / VTT / LRC / 增强 LRC / ASS' }),
      els.saveNow = h('button', { id: 'save-now', 'data-act': 'save', class: 'ghost', text: '立即保存', title: 'Ctrl+S' }),
      els.saveLight = h('span', { id: 'save-light', class: 'light', dataset: { state: 'saved' }, title: '保存状态', role: 'status' }, [
        h('i', { class: 'light__dot' }),
        h('span', { class: 'light__label', text: '已保存' }),
      ]),
    ]),
  );
}

/** ?project=<id> 的显式请求值;'__new__' 表示「就要一个新项目」 */
const URL_PROJECT_NEW = '__new__';

/**
 * 读 ?project=<id> —— 启动时显式指定要打开哪个项目(分享/自动化/多窗口都用得上)。
 * `?project=new`(或 none)返回 `__new__`,表示无视上次记录、直接开一个新项目。
 */
function projectIdFromUrl() {
  try {
    if (typeof location === 'undefined' || !location.search) return null;
    const raw = new URLSearchParams(location.search).get('project');
    if (!raw) return null;
    const v = String(raw).trim();
    if (!v) return null;
    if (v === 'new' || v === 'none') return URL_PROJECT_NEW;
    return v;
  } catch {
    return null;
  }
}

async function restoreSession() {
  const urlId = projectIdFromUrl();
  // ?project=new:用户明确要一个全新的空项目,不要恢复任何上次的东西
  if (urlId === URL_PROJECT_NEW) {
    app.recovery = { at: Date.now(), via: 'url-new', targetId: null };
    await newProject();
    return;
  }
  const lastId = readLastProjectId();
  const mirrorIds = listMirrorIds().filter((id) => id !== DRAFT_ID);
  // URL 参数优先:它是有意显式指定的,应当压过「上次打开的那个」
  const targetId = urlId || lastId || (mirrorIds.length === 1 ? mirrorIds[0] : null);
  const storeLabel = () => (app.store.kind === 'server' ? '服务端' : '本地存储');

  let loaded = null;
  let loadErr = null;
  if (targetId) {
    try {
      loaded = await app.store.loadProject(targetId);
    } catch (err) {
      loadErr = err;
      // URL 明确点名了一个不存在的项目时要说清楚,不能静默地开个空白页
      if (urlId && urlId === targetId) {
        showBanner('error', `地址里指定的项目不存在(${targetId}),已改为空白项目。`, { id: 'url-project', sticky: true });
      }
    }
  }
  const mirror = targetId ? readMirror(targetId) : null;
  // 记录本次启动的恢复来源(调试/自动化可读;也方便排查「为什么刷新后是这个内容」)
  app.recovery = {
    at: Date.now(),
    via: 'none',
    targetId,
    loadedRevision: loaded ? loaded.revision : null,
    mirrorRevision: mirror ? mirror.revision : null,
    mirrorDirty: mirror ? mirror.dirty === true : null,
  };

  // ① 服务端能读到:但仍要检查镜像是否更新(防抖窗口内刷新会留下 dirty 镜像)
  if (loaded) {
    const mirrorWins = !!mirror && (mirror.dirty === true || Number(mirror.revision) > Number(loaded.revision));
    if (mirrorWins) {
      app.recovery.via = 'mirror';
      app.recovery.why = mirror.dirty === true ? 'mirror-dirty' : 'mirror-newer-revision';
      applyProject(mirror.project);
      app.sync.adopt(mirror.project);
      renderAll();
      const why = mirror.dirty === true ? '镜像里有未写入服务端的编辑' : `镜像 r${mirror.revision} 比服务端 r${loaded.revision} 新`;
      showBanner('warn', `检测到上次离开时还有未保存的改动(${why}),已用本地镜像恢复,正在回写${storeLabel()}…`, {
        id: 'recover',
        sticky: true,
        priority: 10, // 必须压过「静态/本地模式」这类常驻提示,否则用户看不到恢复动作
      });
      const st = await app.sync.flush({ force: true });
      if (st.state === 'saved') {
        showBanner('ok', `本地镜像已回写${storeLabel()}(r${st.revision})。`, { id: 'recover', priority: 10 });
        setTimeout(() => hideBanner('recover'), 6000);
      } else {
        app.recoveryWriteFailed = true; // 重试成功后会由 onSyncStatus 把横幅换成成功提示
        showBanner('error', `镜像回写失败:${st.error || st.state}。改动仍安全保存在本地镜像里,稍后会自动重试。`, {
          id: 'recover',
          sticky: true,
          priority: 10,
        });
      }
      return;
    }
    applyProject(loaded);
    app.sync.adopt(loaded);
    renderAll();
    app.recovery.via = 'store';
    return;
  }

  // ② 服务端读不到:用镜像兜底,并明确提示(绝不静默)
  if (mirror) {
    app.recovery.via = 'mirror-offline';
    app.recovery.why = loadErr ? loadErr.message : '项目不存在';
    applyProject(mirror.project);
    app.sync.adopt(mirror.project);
    renderAll();
    showBanner(
      'error',
      `无法从${storeLabel()}读取「${targetId}」(${loadErr ? loadErr.message : '项目不存在'}),已用本地镜像恢复` +
        `${mirror.dirty ? '(含未保存的改动)' : ''}。改动安全,恢复连接后会自动重试保存。`,
      { id: 'recover', sticky: true, priority: 10 },
    );
    const st2 = await app.sync.flush({ force: true });
    app.recoveryWriteFailed = st2.state !== 'saved';
    return;
  }

  // ③ 从未保存过的草稿
  const draft = readMirror(DRAFT_ID);
  if (draft) {
    app.recovery.via = 'draft-mirror';
    applyProject(draft.project);
    app.sync.adopt(draft.project);
    renderAll();
    showBanner('warn', '发现一个上次未保存完的新建项目(本地草稿),已恢复并正在保存…', { id: 'recover', sticky: true, priority: 10 });
    const st3 = await app.sync.flush({ force: true });
    app.recoveryWriteFailed = st3.state !== 'saved';
    return;
  }

  if (loadErr) {
    showBanner('error', `读取上次的项目失败:${loadErr.message}`, { id: 'recover' });
  }
  renderAll();
}

async function attachTimeline() {
  try {
    const [rt, it] = await Promise.all([import('./render_timeline.js'), import('./interact.js')]);
    if (typeof rt.createTimeline !== 'function') throw new Error('render_timeline.js 未导出 createTimeline');
    if (typeof it.attachInteractions !== 'function') throw new Error('interact.js 未导出 attachInteractions');
    app.timeline = rt.createTimeline(els.canvas, app.state);
    if (app.timeline && typeof app.timeline.resize === 'function') app.timeline.resize();
    it.attachInteractions(els.stage, app.state, app.timeline);
    app.mode = 'timeline';
    els.canvas.hidden = false;
    els.timelineFallback.hidden = true;
    document.getElementById('app').dataset.mode = 'timeline';
    queueRender();
  } catch (err) {
    app.mode = 'list';
    els.canvas.hidden = true;
    els.timelineFallback.hidden = false;
    document.getElementById('app').dataset.mode = 'list';
    console.warn('[ui] 模块 B 的时间轴尚未就绪,使用列表模式:', err && err.message ? err.message : err);
    queueRender();
  }
}

async function boot() {
  els.app = $('app');
  els.toolbar = $('toolbar');
  els.banner = $('banner');
  els.trackList = $('track-list');
  els.trackCount = $('track-count');
  els.trackPanelHead = document.querySelector('#track-panel .panel__head');
  els.stage = $('stage');
  els.stageToolbar = $('stage-toolbar');
  els.timelineWrap = $('timeline-wrap');
  els.canvas = $('timeline');
  els.timelineFallback = $('timeline-fallback');
  els.hbar = $('hbar');
  els.hbarThumb = $('hbar-thumb');
  els.vbar = $('vbar');
  els.vbarThumb = $('vbar-thumb');
  els.propsList = $('props-list');
  els.propsHint = $('props-hint');
  els.statusbar = $('statusbar');
  els.modalRoot = $('modal-root');
  els.toast = $('toast');
  els.fileInput = $('midi-file');

  // 1. 运行时二选一:服务端 REST,或静态部署的本地存储
  try {
    app.store = await detectStore();
  } catch (err) {
    console.error('[ui] detectStore 异常,退回本地存储:', err);
    app.store = createLocalStore();
  }

  // 2. state(模块 B 优先)
  app.state = await createState(app.store);

  // 3. 外壳
  renderShell();
  bindToolbar();
  attachScrollbarDrag(els.hbar, els.hbarThumb, 'x');
  attachScrollbarDrag(els.vbar, els.vbarThumb, 'y');
  // 窗口尺寸变了要重算滚动条(canvas 会 resize)
  window.addEventListener('resize', () => queueRender());
  app.sync = createSync(app.state, app.store, { debounceMs: 300, retryMs: 3000, onStatus: onSyncStatus });
  app.unsubscribe = app.state.subscribe(() => queueRender());
  renderAll();
  els.app.dataset.ready = 'true';
  // 调试钩子:方便在控制台或自动化脚本里查看编辑器状态(只读用途,业务逻辑不依赖它)
  try {
    window.__midi2srt = app;
  } catch {
    /* 忽略 */
  }

  // 4. 存储模式提示(不静默)
  if (app.store.kind === 'local') {
    const probe = app.store.probe;
    const reasonText =
      { 'fetch-error': '连接不上服务端接口', timeout: '健康检查超时(1.5s)', 'http-404': '服务端接口不存在', 'no-fetch': '环境没有 fetch' }[probe?.reason] ||
      '未检测到服务端接口';
    showBanner(
      'info', // 常驻但级别低:任何时候有更重要的提示(镜像恢复/保存失败)都能顶到前面
      `静态/本地模式:${reasonText}(GET /api/health),已切换到浏览器 localStorage。项目列表 / 新建 / 打开 / 保存 / 重命名 / 删除 / 历史快照与恢复全部可用。`,
      { id: 'local-mode', sticky: true },
    );
  } else {
    showBanner('info', `已连接服务端(${app.store.baseUrl || '同源'}${app.store.version ? ` · v${app.store.version}` : ''}),所有改动自动保存到服务端。`, { id: 'server-mode' });
    setTimeout(() => hideBanner('server-mode'), 5000);
  }
  if (!app.store.persistent) {
    showBanner('error', '浏览器禁止了本地存储(localStorage 不可写):镜像/离线备份不可用,请尽快保存到服务端。', { id: 'no-storage', sticky: true });
  }

  // 5. 恢复上次的项目(服务端优先 + 镜像兜底)
  await restoreSession();

  // 6. 模块 A / 模块 B 的加载状态,如实告知
  ensureCore().catch((err) => {
    showBanner('warn', `导入 MIDI 所需的核心算法模块(lib/)暂不可用:${err.message || err}`, { id: 'core', sticky: true });
  });
  ensureExporterCore().catch(() => {
    /* 导出时才提示 */
  });
  await attachTimeline();

  if (!app.state.project) {
    showBanner('info', '还没有项目:点「新建」开始,或「导入 MIDI」把 .mid 里的歌词转成字幕片段。', { id: 'welcome' });
  }
  renderAll();
}

boot().catch((err) => {
  console.error('[ui] 启动失败:', err);
  const root = $('app') || document.body;
  const box = h('div', { class: 'empty' });
  box.append(h('div', { text: `界面启动失败:${err && err.message ? err.message : err}` }));
  box.append(h('div', { class: 'hint', text: '请打开浏览器控制台查看详细堆栈。' }));
  root.prepend(box);
});
