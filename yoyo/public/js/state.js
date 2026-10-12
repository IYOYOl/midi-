/**
 * public/js/state.js —— 时间轴编辑器的应用状态(AppState)
 *
 * 契约:INTERFACE.md 第 3 节,方法签名逐字冻结。ui.js 按这些签名调用,不要改。
 *
 * 三条铁律(本文件负责守住):
 *  1. 外部只许通过 mutator 改模型;mutator 内部统一做「改模型 → push 撤销快照 → 标脏 → 通知订阅者」。
 *  2. 一次拖动 = 一条撤销记录:交互层拖动时只更新预览态,松手时用 applyPatches() 一次提交。
 *  3. endMs > startMs 恒成立;locked 轨拒绝一切改动;shift 负数 clamp 到 0。
 *
 * 零依赖、不碰 DOM(纯数据层,可以脱离浏览器直接引用)。
 * 注意:本文件**不 import lib/**,自己实现了一份最小的归一化逻辑,以保持数据层与算法层解耦。
 * lib/segments.mjs 的重断句算法通过 createAppState(store, { regroupSegments }) 注入,见 regroup()。
 */

/** 片段最短时长(INTERFACE.md §1:endMs <= startMs 时补齐到 start + 200) */
export const MIN_SEGMENT_MS = 200;
/** 撤销栈容量 */
export const UNDO_LIMIT = 100;
/** 默认视图 */
export const DEFAULT_VIEW = Object.freeze({
  pxPerMs: 0.05,      // 1 秒 = 50px,60s 的歌约占 3000px
  scrollMs: 0,
  laneHeight: 48,
  playheadMs: 0,
  scrollY: 0          // 轨道多于视口高度时的垂直滚动(附加字段,契约里没有,不影响调用方)
});
export const MIN_PX_PER_MS = 0.0002;
export const MAX_PX_PER_MS = 4;

/* ------------------------------------------------------------------ *
 * 纯函数小工具(全部无副作用,方便单测)
 * ------------------------------------------------------------------ */

function toInt(v, fallback) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? n : fallback;
}

/** 把一个任意对象洗成合法的 Segment(深拷贝:words/source 一律新建对象) */
function sanitizeSegment(raw, fallbackId) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const startMs = Math.max(0, toInt(src.startMs, 0));
  let endMs = toInt(src.endMs, startMs + MIN_SEGMENT_MS);
  if (endMs <= startMs) endMs = startMs + MIN_SEGMENT_MS;   // 恒等式兜底
  return {
    id: String(src.id || fallbackId),
    startMs,
    endMs,
    text: typeof src.text === 'string' ? src.text : (src.text == null ? '' : String(src.text)),
    kind: src.kind === 'meta' ? 'meta' : 'lyric',
    // source 原样浅拷贝保留(吸附要用 tick/ms,不认识的字段也别丢)
    source: src.source && typeof src.source === 'object' ? { ...src.source } : null,
    words: Array.isArray(src.words) ? src.words.map((w) => (w && typeof w === 'object' ? { ...w } : { text: String(w ?? '') })) : null
  };
}

/**
 * 升序 + 不重叠 + endMs > startMs。
 * 重叠时**右移后出现的那一段**(只动时间,绝不截断文本、绝不丢内容)。
 * 注意:用户拖拽路径由 interact.js 在预览阶段就把位置限制在邻居边界之间,
 * 不会走到这条兜底;这条只为「属性面板直接输入时间」这类程序化写入兜底。
 */
function sortAndRepair(list) {
  const segs = list.slice().sort((a, b) => (a.startMs - b.startMs) || (a.endMs - b.endMs));
  for (let i = 0; i < segs.length; i++) {
    let s = segs[i];
    if (s.endMs <= s.startMs) s = segs[i] = { ...s, endMs: s.startMs + MIN_SEGMENT_MS };
    if (i === 0) continue;
    const prev = segs[i - 1];
    if (s.startMs < prev.endMs) {
      const startMs = prev.endMs;
      segs[i] = { ...s, startMs, endMs: Math.max(s.endMs, startMs + MIN_SEGMENT_MS) };
    }
  }
  return segs;
}

/** 局部一致性检查;坏了才退回全量修复,保证 5000 段时单点插入不必全排序 */
function localsOk(arr, i) {
  if (i < 0 || i >= arr.length) return true;
  const s = arr[i];
  if (s.endMs <= s.startMs || s.startMs < 0) return false;
  if (i > 0 && s.startMs < arr[i - 1].endMs) return false;
  if (i + 1 < arr.length && arr[i + 1].startMs < s.endMs) return false;
  return true;
}

function repairAround(arr, i) {
  if (localsOk(arr, i - 1) && localsOk(arr, i) && localsOk(arr, i + 1)) return arr;
  return sortAndRepair(arr);
}

function computeDuration(tracks) {
  let max = 0;
  for (const t of tracks) {
    for (const s of t.segments) if (s.endMs > max) max = s.endMs;
  }
  return max;
}

function uniqueIds(ids) {
  const out = [];
  const seen = new Set();
  for (const id of ids || []) {
    const s = String(id);
    if (!seen.has(s)) { seen.add(s); out.push(s); }
  }
  return out;
}

/** 逐段比较(id/时间/文本/类型),用于判断「重算断句」到底改没改 */
function sameSegmentList(a, b) {
  if (a === b) return true;
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (x === y) continue;
    if (x.id !== y.id || x.startMs !== y.startMs || x.endMs !== y.endMs || x.text !== y.text || x.kind !== y.kind) return false;
  }
  return true;
}

/* ------------------------------------------------------------------ *
 * AppState
 * ------------------------------------------------------------------ */

/**
 * @param {object} store 模块 C 的 Store(本模块只在 state.store 上留个引用,不主动调用)
 * @param {{ regroupSegments?: Function, idPrefix?: string }} [deps]
 *        regroupSegments: 可选注入 lib/segments.mjs 的 regroupSegments(segments, settings)
 * @returns {AppState}
 */
export function createAppState(store = null, deps = {}) {
  const regroupImpl = typeof deps.regroupSegments === 'function' ? deps.regroupSegments : null;
  const idPrefix = typeof deps.idPrefix === 'string' && deps.idPrefix ? deps.idPrefix : 's_';

  let project = null;
  let selection = { trackId: null, segmentIds: [] };
  const view = { ...DEFAULT_VIEW };
  let dirty = false;
  /**
   * version:模型每变一次 +1(视图变化不算)。渲染层/吸附索引用它做缓存失效判断。
   */
  let version = 0;

  const undoStack = [];
  const redoStack = [];
  let idSeq = 0;
  const subscribers = new Set();

  /* ---------------- 通知 ---------------- */

  function notify() {
    for (const fn of Array.from(subscribers)) {
      try { fn(api); } catch (err) { console.error('[state] subscriber 抛错已吞掉:', err); }
    }
  }

  function afterModelChange() {
    version++;
    dirty = true;
    const d = computeDuration(project.tracks);
    // 全删空时保留原 durationMs,免得标尺塌成 0
    if (d > 0) project = { ...project, durationMs: d };
    pruneSelection();
    notify();
  }

  /* ---------------- 快照(撤销栈) ---------------- */

  /**
   * 快照 = 结构共享的深拷贝语义:
   *  - tracks 数组、每轨对象、每轨 segments 数组都是**新建副本**;
   *  - segment 对象本身被当作不可变对象 —— 本文件所有 mutator 都是「造新对象」而不是原地改字段。
   * 因此快照在语义上等价于 tracks 深拷贝,但成本是 O(轨道数 + 段数) 的指针复制,
   * 而不是每次改一个字段就深拷贝 5000 个对象(那会让 1000 次修改多花几秒)。
   */
  function cloneTrack(t) {
    return { id: t.id, name: t.name, visible: t.visible !== false, locked: !!t.locked, segments: t.segments.slice() };
  }

  function snapshot() {
    return {
      tracks: project.tracks.map(cloneTrack),
      settings: { ...project.settings },
      durationMs: project.durationMs,
      selection: { trackId: selection.trackId, segmentIds: selection.segmentIds.slice() }
    };
  }

  function pushUndo(snap) {
    undoStack.push(snap);
    if (undoStack.length > UNDO_LIMIT) undoStack.shift();
  }

  function restore(snap) {
    project = { ...project, tracks: snap.tracks.map(cloneTrack), settings: { ...snap.settings }, durationMs: snap.durationMs };
    selection = { trackId: snap.selection.trackId, segmentIds: snap.selection.segmentIds.slice() };
    pruneSelection();
  }

  /* ---------------- 查询辅助 ---------------- */

  function trackById(trackId) {
    if (!project) return null;
    return project.tracks.find((t) => t.id === trackId) || null;
  }

  function segmentById(trackId, segmentId) {
    const t = trackById(trackId);
    if (!t) return null;
    return t.segments.find((s) => s.id === segmentId) || null;
  }

  function isLocked(trackId) {
    const t = trackById(trackId);
    return !t || !!t.locked;
  }

  function pruneSelection() {
    if (!project) { selection = { trackId: null, segmentIds: [] }; return; }
    const t = selection.trackId ? trackById(selection.trackId) : null;
    if (!t) { selection = { trackId: null, segmentIds: [] }; return; }
    const alive = new Set(t.segments.map((s) => s.id));
    const kept = selection.segmentIds.filter((id) => alive.has(id));
    if (kept.length !== selection.segmentIds.length) selection = { trackId: selection.trackId, segmentIds: kept };
    if (!kept.length && selection.trackId) selection = { trackId: selection.trackId, segmentIds: [] };
  }

  function nextId() {
    const alive = new Set();
    if (project) for (const t of project.tracks) for (const s of t.segments) alive.add(s.id);
    let id;
    do { id = `${idPrefix}${++idSeq}`; } while (alive.has(id));
    return id;
  }

  /** 换掉一整条轨(tracks 数组与轨对象都是新的;updater 必须返回新对象) */
  function replaceTrack(trackId, updater) {
    const idx = project.tracks.findIndex((t) => t.id === trackId);
    if (idx < 0) return false;
    const next = updater(project.tracks[idx]);
    if (!next) return false;
    const tracks = project.tracks.slice();
    tracks[idx] = next;
    project = { ...project, tracks };
    return true;
  }

  /** 只改某轨的 segments 数组 */
  function replaceSegments(trackId, segments) {
    return replaceTrack(trackId, (t) => ({ ...t, segments }));
  }

  /* ---------------- 统一的 mutator 外壳 ---------------- */

  /**
   * 所有会改模型的 mutator 都从这里走:改动前取快照 → 执行 → 只有真的变了才入栈并通知。
   * (契约要求「改动前 push 快照」;这里把「没变化就不入栈」也做进来,
   *  否则点一下没拖动的鼠标也会留下一条空撤销记录。)
   * @returns {boolean} 是否真的改了
   */
  function mutate(fn) {
    if (!project) return false;
    const before = snapshot();
    let changed = false;
    try {
      changed = fn() === true;
    } catch (err) {
      // 出错就回滚到快照,别留半个中间态
      restore(before);
      throw err;
    }
    if (!changed) return false;
    pushUndo(before);
    redoStack.length = 0;      // 新改动清空 redo 栈
    afterModelChange();
    return true;
  }

  /** 线性检查:升序 + 不重叠 + endMs > startMs。坏了才做全量修复 */
  function isConsistent(arr) {
    for (let i = 0; i < arr.length; i++) {
      const s = arr[i];
      if (s.startMs < 0 || s.endMs <= s.startMs) return false;
      if (i > 0 && s.startMs < arr[i - 1].endMs) return false;
    }
    return true;
  }

  /** 计算单条 patch 的新对象(没变化就原样返回 prev) */
  function patchOne(prev, patch) {
    const p = patch || {};
    let next = prev;
    if (p.text !== undefined && p.text !== prev.text) next = { ...next, text: String(p.text) };
    if (p.kind !== undefined) {
      const kind = p.kind === 'meta' ? 'meta' : 'lyric';
      if (kind !== next.kind) next = { ...next, kind };
    }
    const wantedStart = p.startMs !== undefined ? Math.max(0, toInt(p.startMs, next.startMs)) : next.startMs;
    const wantedEnd = p.endMs !== undefined ? toInt(p.endMs, next.endMs) : next.endMs;
    if (wantedStart !== next.startMs || wantedEnd !== next.endMs) {
      let startMs = wantedStart;
      let endMs = wantedEnd;
      if (endMs <= startMs) endMs = startMs + MIN_SEGMENT_MS;   // 恒等式补齐
      next = { ...next, startMs, endMs };
    }
    return next;
  }

  /**
   * 把一批 patch 落到「同一轨」上,返回新的 segments 数组(没变化返回 null)。
   *
   * ★ 关键:整批 patch 必须**原子**落地 —— 先把所有 patch 的值全部算出来写进新数组,
   *   最后只做一次归一化。如果逐条「改一条就修复一次」,拖动整块片段时中间态里
   *   「已移动的」和「还没移动的」会互相判定重叠,结果被一段段挤开,
   *   提交出来的位置和拖动预览不一致(这是实测抓到的 bug,browser 自检 + 单测都覆盖了)。
   */
  function applyPatchesToTrack(track, ops) {
    if (!ops.length) return null;

    // —— 快路径:只有一条 patch(改一条文本 / 面板里输入一个时间),不做额外索引 ——
    if (ops.length === 1) {
      const op = ops[0];
      const i = track.segments.findIndex((s) => s.id === op.segmentId);
      if (i < 0) return null;
      const prev = track.segments[i];
      const next = patchOne(prev, op.patch);
      if (next === prev) return null;
      const arr = track.segments.slice();
      arr[i] = next;
      if (next.startMs === prev.startMs) return repairAround(arr, i);   // 位置没动:只查本地邻居
      return isConsistent(arr) ? arr : sortAndRepair(arr);             // 时间变了:整体线性自检
    }

    // —— 批量(拖拽提交):原子落地 ——
    const index = new Map();
    for (let i = 0; i < track.segments.length; i++) index.set(track.segments[i].id, i);
    const patched = new Map();
    let timeMoved = false;
    for (const op of ops) {
      const i = index.get(op.segmentId);
      if (i === undefined) continue;
      const prev = track.segments[i];
      const next = patchOne(prev, op.patch);
      if (next === prev) continue;
      if (next.startMs !== prev.startMs || next.endMs !== prev.endMs) timeMoved = true;
      patched.set(prev.id, next);
    }
    if (!patched.size) return null;

    const merged = track.segments.map((s) => patched.get(s.id) || s);
    if (!timeMoved) return merged;              // 只改文本/类型:位置没动,顺序天然不变
    if (isConsistent(merged)) return merged;    // 本批整体合法(拖拽路径的常态):一次线性检查就够
    return sortAndRepair(merged);               // 极少数程序化写入造成重叠:全量修复兜底
  }

  /* ---------------- 契约里的 mutator ---------------- */

  function setSegments(trackId, segments) {
    return mutate(() => {
      const t = trackById(trackId);
      if (!t || t.locked) return false;
      const list = Array.isArray(segments) ? segments : [];
      // 洗一遍:深拷贝 + id 唯一 + 归一化。这里是模型边界,进来的对象一律不保留引用。
      const seen = new Set();
      const out = [];
      for (const s of list) {
        const seg = sanitizeSegment(s, nextId());
        if (seen.has(seg.id)) seg.id = nextId();
        seen.add(seg.id);
        out.push(seg);
      }
      return replaceSegments(trackId, sortAndRepair(out));
    });
  }

  function updateSegment(trackId, segmentId, patch) {
    return mutate(() => {
      const t = trackById(trackId);
      if (!t || t.locked) return false;
      const segs = applyPatchesToTrack(t, [{ segmentId, patch }]);
      return segs ? replaceSegments(trackId, segs) : false;
    });
  }

  /**
   * applyPatches(ops) —— 附加批量 mutator(不在冻结契约里,但完全走同一条纪律)。
   * 交互层一次拖动/一次方向键位移有多条片段要改,必须**一次**调用它,
   * 这样整个动作只产生一条撤销记录。ops = [{ trackId, segmentId, patch }]
   */
  function applyPatches(ops) {
    return mutate(() => {
      const list = Array.isArray(ops) ? ops : [];
      const byTrack = new Map();
      for (const op of list) {
        if (!op || !op.trackId || !op.segmentId) continue;
        if (isLocked(op.trackId)) continue;
        if (!byTrack.has(op.trackId)) byTrack.set(op.trackId, []);
        byTrack.get(op.trackId).push(op);
      }
      let changed = false;
      for (const [trackId, group] of byTrack) {
        const t = trackById(trackId);
        if (!t) continue;
        const segs = applyPatchesToTrack(t, group);
        if (segs && replaceSegments(trackId, segs)) changed = true;
      }
      return changed;
    });
  }

  /**
   * 把若干片段从一条轨移到另一条轨(拖到别的泳道),可同时改它们的时间。
   *
   * 为什么单独一个 mutator 而不是走 applyPatches:applyPatches 是**按 trackId 分组**
   * 去改每条轨内部的时间/文本的,它根本没有"换轨"这个概念 ——
   * 片段换轨必须在同一次 mutate 里做「源轨移除 + 目标轨插入 + 目标轨归一化」。
   * 而时间也必须在这同一次里改完,否则"先改时间再换轨"会留下两条撤销记录,
   * 用户按一次 Ctrl+Z 只退回一半,这是最典型的实现事故。
   *
   * @param {Array<string>} segmentIds
   * @param {string} toTrackId
   * @param {Map<string,{startMs:number,endMs:number}>|Object} [patches] 新的起止时间(可省略)
   * @returns {boolean} 是否真的移动了
   */
  function moveSegments(fromTrackId, segmentIds, toTrackId, patches) {
    return mutate(() => {
      if (!fromTrackId || !toTrackId) return false;
      if (fromTrackId === toTrackId) return false;
      const from = trackById(fromTrackId);
      const to = trackById(toTrackId);
      if (!from || !to) return false;
      // 源轨锁定 → 不许从里面拿走;目标轨锁定 → 不许往里塞
      if (from.locked || to.locked) return false;

      const moving = new Set(uniqueIds(segmentIds));
      if (!moving.size) return false;
      const picked = [];
      for (const s of from.segments) {
        if (!moving.has(s.id)) continue;
        const p = patches ? (patches instanceof Map ? patches.get(s.id) : patches[s.id]) : null;
        picked.push(p ? patchOne(s, p) : s);
      }
      if (!picked.length) return false;

      const keptFrom = from.segments.filter((s) => !moving.has(s.id));
      const merged = to.segments.concat(picked);
      // 目标轨里可能本来就压着东西:整体排序 + 修复重叠(与拖拽提交同一套规则)
      merged.sort((a, b) => a.startMs - b.startMs || String(a.id).localeCompare(String(b.id)));
      const nextTo = isConsistent(merged) ? merged : sortAndRepair(merged);

      from.segments = keptFrom;
      to.segments = nextTo;
      // 选中跟着片段走,否则属性面板会指着一个已经不在当前轨里的片段。
      // 注意:不能只看 selection —— 调用方可能压根没先选过(比如脚本或自动化),
      // 那样 filter 出来是空集,用户拖完会发现片段没被选中、属性面板空着。
      // 所以「原本就选中了其中一部分」才沿用,否则自动选中这次移动的全部。
      const alreadySelected = selection.segmentIds.filter((id) => moving.has(id));
      selection = { trackId: to.id, segmentIds: alreadySelected.length ? alreadySelected : Array.from(moving) };
      return true;
    });
  }

  function addSegment(trackId, segment) {
    let newId = null;
    mutate(() => {
      const t = trackById(trackId);
      if (!t || t.locked) return false;
      const seg = sanitizeSegment(segment, nextId());
      if (t.segments.some((s) => s.id === seg.id)) seg.id = nextId();
      newId = seg.id;
      const list = t.segments.slice();
      let lo = 0;
      let hi = list.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (list[mid].startMs < seg.startMs) lo = mid + 1; else hi = mid; }
      list.splice(lo, 0, seg);
      return replaceSegments(trackId, repairAround(list, lo));
    });
    // 契约说返回 void;这里顺带把新 id 交出去(忽略返回值也完全兼容)
    return newId;
  }

  function removeSegments(trackId, segmentIds) {
    return mutate(() => {
      const t = trackById(trackId);
      if (!t || t.locked) return false;
      const kill = new Set(uniqueIds(segmentIds));
      if (!kill.size) return false;
      const kept = t.segments.filter((s) => !kill.has(s.id));
      if (kept.length === t.segments.length) return false;
      return replaceSegments(trackId, kept);
    });
  }

  function splitSegmentAt(trackId, segmentId, atMs) {
    let ok = false;
    mutate(() => {
      const t = trackById(trackId);
      if (!t || t.locked) return false;
      const i = t.segments.findIndex((s) => s.id === segmentId);
      if (i < 0) return false;
      const seg = t.segments[i];
      const at = Math.round(Number(atMs));
      // 拆分点落在段外(含端点)一律拒绝
      if (!Number.isFinite(at) || at <= seg.startMs || at >= seg.endMs) return false;
      const left = { ...seg, endMs: at };
      const right = { ...seg, id: nextId(), startMs: at, source: null };
      if (Array.isArray(seg.words)) {
        const lw = [];
        const rw = [];
        for (const w of seg.words) {
          const ws = toInt(w.startMs, seg.startMs);
          const we = toInt(w.endMs, ws);
          if (we <= at) lw.push({ ...w, startMs: ws, endMs: Math.min(we, at) });
          else if (ws >= at) rw.push({ ...w, startMs: Math.max(ws, at), endMs: we });
          else { lw.push({ ...w, startMs: ws, endMs: at }); rw.push({ ...w, startMs: at, endMs: we }); }
        }
        left.words = lw;
        right.words = rw;
        left.text = lw.map((w) => w.text).join('');
        right.text = rw.map((w) => w.text).join('');
      } else {
        right.text = '';   // 没有逐字时间就无法切文本,右半留空等用户补
      }
      const list = t.segments.slice();
      list.splice(i, 1, left, right);
      ok = replaceSegments(trackId, list);
      return ok;
    });
    return ok;
  }

  function mergeWithNext(trackId, segmentId) {
    return mutate(() => {
      const t = trackById(trackId);
      if (!t || t.locked) return false;
      const i = t.segments.findIndex((s) => s.id === segmentId);
      if (i < 0 || i + 1 >= t.segments.length) return false;
      const a = t.segments[i];
      const b = t.segments[i + 1];
      // 必须同轨(同一条 segments 数组内)且时间相邻:中间无其它段,间隔不超过 settings.gapMs
      const gap = b.startMs - a.endMs;
      const maxGap = Math.max(0, toInt(project.settings.gapMs, 0));
      if (gap < 0 || gap > maxGap) return false;
      const words = (Array.isArray(a.words) || Array.isArray(b.words))
        ? [...(a.words || []), ...(b.words || [])]
        : null;
      const merged = {
        ...a,
        endMs: b.endMs,
        text: `${a.text}${b.text}`,
        kind: a.kind === 'meta' && b.kind === 'meta' ? 'meta' : 'lyric',
        words
      };
      const list = t.segments.slice();
      list.splice(i, 2, merged);
      return replaceSegments(trackId, list);
    });
  }

  /** 计算把某批轨整体平移 offsetMs 时,实际能用的偏移(结果 clamp 到 >= 0) */
  function clampShift(tracks, offsetMs) {
    const off = Math.round(Number(offsetMs));
    if (!Number.isFinite(off) || off === 0) return 0;
    let minStart = Infinity;
    for (const t of tracks) {
      if (t.locked) continue;
      for (const s of t.segments) if (s.startMs < minStart) minStart = s.startMs;
    }
    if (minStart === Infinity) return 0;
    return Math.max(off, -minStart);   // 负数结果 clamp 到 0,绝不留负时间
  }

  function shiftTrack(trackId, offsetMs) {
    return mutate(() => {
      const t = trackById(trackId);
      if (!t || t.locked) return false;
      const off = clampShift([t], offsetMs);
      if (!off) return false;
      const segs = t.segments.map((s) => ({ ...s, startMs: s.startMs + off, endMs: s.endMs + off }));
      return replaceSegments(trackId, segs);
    });
  }

  function shiftAll(offsetMs) {
    return mutate(() => {
      const off = clampShift(project.tracks, offsetMs);
      if (!off) return false;
      const tracks = project.tracks.map((t) => {
        if (t.locked) return t;   // locked 轨拒绝一切修改
        return { ...t, segments: t.segments.map((s) => ({ ...s, startMs: s.startMs + off, endMs: s.endMs + off })) };
      });
      project = { ...project, tracks };
      return true;
    });
  }

  /**
   * regroup(settingsPatch) —— 改 settings 后重算断句。
   * 优先用注入的 lib/segments.mjs regroupSegments(它懂「claimed 段原样保留」);
   * 没注入时用本文件的内置保守实现:有 words 的段按新 gapMs 重新切/并,没有 words 的段原样不动。
   */
  function regroup(settingsPatch) {
    return mutate(() => {
      const patch = settingsPatch && typeof settingsPatch === 'object' ? settingsPatch : {};
      const nextSettings = { ...project.settings };
      for (const key of Object.keys(patch)) {
        if (patch[key] === undefined) continue;
        nextSettings[key] = patch[key];
      }
      const settings = {
        gapMs: Math.max(0, toInt(nextSettings.gapMs, 600)),
        breakChars: typeof nextSettings.breakChars === 'string' ? nextSettings.breakChars : '',
        minDurationMs: Math.max(1, toInt(nextSettings.minDurationMs, 200))
      };
      const settingsDiffer = settings.gapMs !== project.settings.gapMs
        || settings.breakChars !== project.settings.breakChars
        || settings.minDurationMs !== project.settings.minDurationMs;

      let tracksChanged = false;
      const tracks = project.tracks.map((t) => {
        if (t.locked) return t;   // locked 轨拒绝一切修改(含重算断句)
        const next = regroupImpl ? regroupImpl(t.segments, settings) : fallbackRegroup(t.segments, settings);
        const segs = sortAndRepair((Array.isArray(next) ? next : t.segments).map((s) => sanitizeSegment(s, nextId())));
        if (!sameSegmentList(segs, t.segments)) {
          tracksChanged = true;
          return { ...t, segments: segs };
        }
        return t;
      });

      if (!tracksChanged && !settingsDiffer) return false;
      if (tracksChanged) project = { ...project, tracks };
      project = { ...project, settings };
      return true;
    });
  }

  /** 内置兜底重断句:只在有逐字时间的段上作业;无 words 的段原样保留(诚实的能力边界) */
  function fallbackRegroup(segments, settings) {
    const out = [];
    let cur = null;
    for (const seg of segments) {
      const words = Array.isArray(seg.words) && seg.words.length ? seg.words : null;
      if (!words) { if (cur) { out.push(cur); cur = null; } out.push(seg); continue; }
      // 段内:按 words 间隔重新切(间隔 > gapMs 或前一字以 breakChars 结尾)
      const pieces = [];
      let buf = null;
      for (const w of words) {
        const ws = toInt(w.startMs, seg.startMs);
        const we = Math.max(ws + 1, toInt(w.endMs, ws + 1));
        if (!buf) buf = { startMs: ws, endMs: we, words: [{ ...w, startMs: ws, endMs: we }] };
        else {
          const gap = ws - buf.words[buf.words.length - 1].endMs;
          const lastChar = String(buf.words[buf.words.length - 1].text || '').slice(-1);
          if (gap > settings.gapMs || settings.breakChars.includes(lastChar)) {
            pieces.push(buf);
            buf = { startMs: ws, endMs: we, words: [{ ...w, startMs: ws, endMs: we }] };
          } else {
            buf.endMs = we;
            buf.words.push({ ...w, startMs: ws, endMs: we });
          }
        }
      }
      if (buf) pieces.push(buf);
      for (const p of pieces) {
        out.push({
          ...seg,
          id: p === pieces[0] ? seg.id : nextId(),
          startMs: p.startMs,
          endMs: Math.max(p.startMs + settings.minDurationMs, p.endMs),
          text: p.words.map((w) => w.text).join(''),
          words: p.words
        });
      }
    }
    return sortAndRepair(out);
  }

  function setTrackFlag(trackId, flag, value) {
    return mutate(() => {
      if (flag !== 'visible' && flag !== 'locked') return false;
      const t = trackById(trackId);
      if (!t) return false;
      const v = !!value;
      if (flag === 'locked' && t.locked === v) return false;
      if (flag === 'visible' && (t.visible !== false) === v) return false;
      return replaceTrack(trackId, (cur) => ({ ...cur, [flag]: v }));
    });
  }

  function setTrackName(trackId, name) {
    return mutate(() => {
      const t = trackById(trackId);
      if (!t || t.locked) return false;
      const n = String(name == null ? '' : name);
      if (n === t.name) return false;
      return replaceTrack(trackId, (cur) => ({ ...cur, name: n }));
    });
  }

  /* ---------------- 轨道本身的增删移 ---------------- */

  /**
   * 生成一个没被占用的轨 id。
   * 不能简单地用 `t_${tracks.length + 1}`:删掉中间某条轨之后长度会把
   * 已有的 id 撞上,而 id 一旦重复,选中、拖动、命中测试全都会指向错的轨。
   */
  function nextTrackId() {
    const alive = new Set();
    if (project) for (const t of project.tracks) alive.add(t.id);
    let n = 0;
    while (alive.has(`t_${++n}`)) { /* 继续找 */ }
    return `t_${n}`;
  }

  /** 新建一条空轨道,返回新轨 id。滚动到新轨由 ui.js 负责(它才知道视口多高) */
  function addTrack(name) {
    if (!project) return null;
    let newId = null;
    mutate(() => {
      const id = nextTrackId();
      const track = {
        id,
        name: String(name == null || name === '' ? `轨道 ${project.tracks.length + 1}` : name),
        visible: true,
        locked: false,
        segments: []
      };
      project.tracks = [...project.tracks, track];
      newId = id;
      return true;
    });
    return newId;
  }

  /** 删除一条轨道(连同它的片段);返回是否真的删了 */
  function removeTrack(trackId) {
    return mutate(() => {
      const idx = project.tracks.findIndex((t) => t.id === trackId);
      if (idx < 0) return false;
      const next = project.tracks.slice();
      next.splice(idx, 1);
      project.tracks = next;
      // 被删的轨如果正被选中,清掉选中,否则属性面板会指着一个不存在的轨
      if (selection.trackId === trackId) selection = { trackId: next[0] ? next[0].id : null, segmentIds: [] };
      return true;
    });
  }

  /** 把轨道在列表里上移/下移一位(dir: -1 上移, +1 下移);返回是否真的动了 */
  function moveTrack(trackId, dir) {
    return mutate(() => {
      const idx = project.tracks.findIndex((t) => t.id === trackId);
      if (idx < 0) return false;
      const to = idx + (dir < 0 ? -1 : 1);
      if (to < 0 || to >= project.tracks.length) return false;
      const next = project.tracks.slice();
      const [moved] = next.splice(idx, 1);
      next.splice(to, 0, moved);
      project.tracks = next;
      return true;
    });
  }

  /* ---------------- 选择 / 视图(不改模型:不标脏、不入撤销栈) ---------------- */

  function select(trackId, segmentIds, mode = 'replace') {
    const ids = uniqueIds(segmentIds);
    let nextIds;
    if (mode === 'add') {
      const base = selection.trackId === trackId ? selection.segmentIds : [];
      nextIds = uniqueIds([...base, ...ids]);
    } else if (mode === 'toggle') {
      const base = selection.trackId === trackId ? selection.segmentIds.slice() : [];
      for (const id of ids) {
        const i = base.indexOf(id);
        if (i >= 0) base.splice(i, 1);
        else base.push(id);
      }
      nextIds = base;
    } else {
      nextIds = ids;
    }
    const nextTrackId = trackId == null ? null : trackId;
    const same = nextTrackId === selection.trackId
      && nextIds.length === selection.segmentIds.length
      && nextIds.every((id, i) => selection.segmentIds[i] === id);
    if (same) return false;
    selection = { trackId: nextTrackId, segmentIds: nextIds };
    pruneSelection();
    notify();
    return true;
  }

  /** 视图 patch 的实际落地(不通知),返回是否变化 */
  function applyViewPatch(patch) {
    const p = patch && typeof patch === 'object' ? patch : {};
    let changed = false;
    if (p.pxPerMs !== undefined) {
      const v = Math.min(MAX_PX_PER_MS, Math.max(MIN_PX_PER_MS, Number(p.pxPerMs) || view.pxPerMs));
      if (v !== view.pxPerMs) { view.pxPerMs = v; changed = true; }
    }
    if (p.scrollMs !== undefined) {
      const v = Math.max(0, Math.round(Number(p.scrollMs) || 0));
      if (v !== view.scrollMs) { view.scrollMs = v; changed = true; }
    }
    if (p.laneHeight !== undefined) {
      const v = Math.min(200, Math.max(16, Math.round(Number(p.laneHeight) || view.laneHeight)));
      if (v !== view.laneHeight) { view.laneHeight = v; changed = true; }
    }
    if (p.playheadMs !== undefined) {
      const v = Math.max(0, Math.round(Number(p.playheadMs) || 0));
      if (v !== view.playheadMs) { view.playheadMs = v; changed = true; }
    }
    if (p.scrollY !== undefined) {
      const v = Math.max(0, Math.round(Number(p.scrollY) || 0));
      if (v !== view.scrollY) { view.scrollY = v; changed = true; }
    }
    return changed;
  }

  function setView(patch) {
    const changed = applyViewPatch(patch);
    if (changed) notify();
    return changed;
  }

  /* ---------------- 撤销 / 重做 ---------------- */

  function undo() {
    if (!undoStack.length) return false;
    const cur = snapshot();
    const snap = undoStack.pop();
    redoStack.push(cur);
    restore(snap);
    dirty = true;        // 撤销本身也是改动,也要落盘
    version++;
    notify();
    return true;
  }

  function redo() {
    if (!redoStack.length) return false;
    const cur = snapshot();
    const snap = redoStack.pop();
    undoStack.push(cur);
    restore(snap);
    dirty = true;
    version++;
    notify();
    return true;
  }

  const canUndo = () => undoStack.length > 0;
  const canRedo = () => redoStack.length > 0;

  /* ---------------- 订阅 / 脏标记 ---------------- */

  function subscribe(fn) {
    if (typeof fn !== 'function') return () => {};
    subscribers.add(fn);
    return () => subscribers.delete(fn);
  }

  const isDirty = () => dirty;

  function markClean(revision) {
    dirty = false;
    if (revision !== undefined && revision !== null && project) {
      const rev = toInt(revision, project.revision);
      if (rev !== project.revision) project = { ...project, revision: rev };
    }
    notify();
    return true;
  }

  /** 载入项目:不走撤销栈(加载不是编辑),但会通知;默认不标脏 */
  function loadProject(nextProject, opts = {}) {
    if (!nextProject || typeof nextProject !== 'object') return false;
    const tracks = Array.isArray(nextProject.tracks) ? nextProject.tracks : [];
    const cleaned = tracks.map((t, ti) => {
      const raw = t && typeof t === 'object' ? t : {};
      const segs = Array.isArray(raw.segments) ? raw.segments : [];
      return {
        id: String(raw.id || `t_${ti + 1}`),
        name: String(raw.name == null ? `Track ${ti + 1}` : raw.name),
        visible: raw.visible !== false,
        locked: !!raw.locked,
        segments: sortAndRepair(segs.map((s, i) => sanitizeSegment(s, `${idPrefix}${i + 1}`)))
      };
    });
    project = {
      ...nextProject,
      tracks: cleaned,
      settings: {
        gapMs: Math.max(0, toInt(nextProject.settings && nextProject.settings.gapMs, 600)),
        breakChars: typeof (nextProject.settings && nextProject.settings.breakChars) === 'string'
          ? nextProject.settings.breakChars : '。!?…—、,.！？',
        minDurationMs: Math.max(1, toInt(nextProject.settings && nextProject.settings.minDurationMs, 200))
      },
      durationMs: Math.max(0, toInt(nextProject.durationMs, 0)) || computeDuration(cleaned)
    };
    undoStack.length = 0;
    redoStack.length = 0;
    selection = { trackId: null, segmentIds: [] };
    // id 序号接着已有编号走,避免拆分/新增时撞 id(用循环,不用 Math.max(...ids) 以免上万段时爆栈)
    let maxSeq = idSeq;
    for (const t of cleaned) {
      for (const s of t.segments) {
        const m = /_(\d+)$/.exec(s.id);
        if (m) { const n = Number(m[1]); if (n > maxSeq) maxSeq = n; }
      }
    }
    idSeq = maxSeq;
    if (opts.resetView) Object.assign(view, DEFAULT_VIEW, opts.view || {});
    else if (opts.view) applyViewPatch(opts.view);   // 载入时的视图调整并入下面这一次通知
    dirty = opts.dirty === true;
    version++;
    notify();
    return true;
  }

  /* ---------------- 组装 ---------------- */

  const api = {
    store,
    get project() { return project; },
    // 允许 ui.js 直接赋值载入项目(state.project = p),内部会洗一遍并通知
    set project(p) { loadProject(p); },
    get selection() { return selection; },
    get view() { return view; },
    get dirty() { return dirty; },
    get version() { return version; },

    // —— 冻结契约里的 mutator ——
    setSegments,
    updateSegment,
    addSegment,
    removeSegments,
    splitSegmentAt,
    mergeWithNext,
    shiftTrack,
    shiftAll,
    regroup,
    setTrackFlag,
    setTrackName,
    addTrack,
    removeTrack,
    moveTrack,
    moveSegments,
    select,
    setView,
    undo,
    redo,
    canUndo,
    canRedo,
    subscribe,
    isDirty,
    markClean,

    // —— 附加(不改变上面积分契约;ui.js 用不到也没关系)——
    loadProject,
    applyPatches,      // 批量提交:一次拖动/一次位移只产生一条撤销记录
    trackById,
    segmentById,
    isTrackLocked: isLocked,
    undoDepth: () => undoStack.length,
    redoDepth: () => redoStack.length
  };

  return api;
}

export default createAppState;
