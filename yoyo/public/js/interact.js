/**
 * public/js/interact.js —— 时间轴交互层(指针 / 滚轮 / 键盘 / 就地文本编辑)
 *
 * 契约:INTERFACE.md 第 3 节
 *   attachInteractions(el, state, timeline)   // 返回 detach()(附加便利,契约只要求挂上事件)
 *
 * 数据纪律(本文件最要紧的一条):
 *   ★ 拖动过程中**绝不**调用 state 的 mutator,也不碰 project.tracks[i].segments[j]。
 *     拖动只更新本文件里的 preview 对象,交给 timeline.setPreview() 画出来;
 *     松手那一刻才用 **一次** state.applyPatches(ops) 提交 → 一次拖动 = 一条撤销记录。
 *   (若每帧都调 updateSegment,用户按一次 Ctrl+Z 只会退回一帧,这是最典型的实现事故。)
 *
 * 其它实现要点:
 *   - 命中测试走 timeline.hitTest(),它内部按可见时间窗口裁剪(5000 段也不全量遍历)。
 *   - 吸附 ±6px:其它片段边界、播放头、整秒、以及 segment.source 对应的原始 MIDI 时间。
 *     候选表在按下指针时构建一次并**按毫秒排序**,每帧只做二分找最近点,不会随帧数变慢。
 *   - 拖动位置在预览阶段就按「邻居边界」clamp:因为数据模型规定同轨片段不重叠,
 *     用户拖到邻居身上时会停在边界上(剪辑软件里的"顶住"手感),绝不会产生重叠数据。
 */
import { MIN_SEGMENT_MS } from './state.js';

const DRAG_THRESHOLD_PX = 3;      // 移动不超过这个距离算点击,不算拖动
const SNAP_PX = 6;                // 吸附半径(像素)
const ZOOM_STEP = 1.15;
const NUDGE_MS = 10;
const NUDGE_BIG_MS = 100;
const MIN_ZOOM_OUT = 0.0002;
const MAX_ZOOM_IN = 4;

const SNAP_PRIORITY = { source: 4, segment: 3, playhead: 2, second: 1 };
const SNAP_LABEL = { source: '原始时间', segment: '片段', playhead: '播放头', second: '整秒' };

export function attachInteractions(el, state, timeline) {
  const canvasEl = timeline.canvasEl || el;
  const prevTouchAction = el.style ? el.style.touchAction : '';
  if (el.style) el.style.touchAction = 'none';   // 触屏上拖动不要顺带滚页面

  let mode = 'idle';       // idle | drag | marquee | scrub
  let sess = null;
  let raf = 0;
  let detached = false;

  /* ------------------------------------------------------------------ *
   * 通用工具
   * ------------------------------------------------------------------ */

  function scheduleRender() {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      if (!detached) timeline.render();
    });
  }

  function renderNow() {
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    if (!detached) timeline.render();
  }

  /** 事件坐标 → canvas 内的 CSS 像素坐标 */
  function localPoint(e) {
    const r = canvasEl.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  /**
   * 指针是否真的落在 canvas 范围内。
   *
   * 必须查这个:pointerdown 是挂在**整个 stage** 上的(stage 里除了 canvas
   * 还有上方的舞台工具栏和覆盖在上面的滚动条),而 localPoint 是相对 canvas
   * 算的 —— 于是点工具栏按钮时,按钮的 y 坐标在 canvas 坐标系里可能落在标尺区,
   * 被当成「拖播放头」处理,按钮自己的 click 反而被打断。
   * 实测:点「适配」按钮没反应,播放头却跳了。
   */
  function pointInCanvas(e) {
    const r = canvasEl.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
  }

  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

  function selectedTrack() {
    return state.selection.trackId ? state.trackById(state.selection.trackId) : null;
  }

  function selectedIds() {
    return state.selection.segmentIds.slice();
  }

  function isEditableTarget(t) {
    if (!t || !t.tagName) return false;
    const tag = t.tagName.toLowerCase();
    return tag === 'input' || tag === 'textarea' || tag === 'select' || t.isContentEditable === true;
  }

  /* ------------------------------------------------------------------ *
   * 预览态
   * ------------------------------------------------------------------ */

  function setDragPreview() {
    timeline.setPreview(sess && sess.patches
      ? { kind: 'drag', trackId: sess.trackId, patches: sess.patches, snap: sess.snap, dropTrackId: sess.dropTrackId || null }
      : null);
  }

  function clearPreview() {
    timeline.setPreview(null);
  }

  /* ------------------------------------------------------------------ *
   * 拖动范围 / 吸附候选
   * ------------------------------------------------------------------ */

  /**
   * 求「一批片段整体平移」允许的 delta 区间(不重叠 + 不越过 0)。
   * 只看紧邻的**未选中**片段:选中的那些一起动,相对关系不变。
   */
  function computeMoveBounds(track, ids) {
    const set = new Set(ids);
    const segs = track.segments;
    let lo = -Infinity;
    let hi = Infinity;
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i];
      if (!set.has(s.id)) continue;
      let prevEnd = 0;
      for (let k = i - 1; k >= 0; k--) if (!set.has(segs[k].id)) { prevEnd = segs[k].endMs; break; }
      let nextStart = Infinity;
      for (let k = i + 1; k < segs.length; k++) if (!set.has(segs[k].id)) { nextStart = segs[k].startMs; break; }
      lo = Math.max(lo, prevEnd - s.startMs);
      hi = Math.min(hi, nextStart - s.endMs);
    }
    if (!Number.isFinite(lo)) lo = 0;
    if (lo > hi) hi = lo;    // 没有任何余量:停在最靠左的合法位置
    return { lo, hi };
  }

  /**
   * tick → ms 的近似映射:用同轨各片段的 (source.tick, startMs) 当采样点做分段线性插值。
   * 项目里没有存 tempo map(project.midi 只有 ppq),而这些采样点本身就来自 tempo map 的换算,
   * 所以这是没有 tempo map 时能得到的最合理近似;source.ms 存在时直接用它。
   * 结果按 state.version 缓存,拖动过程中模型不变 → 整个拖动过程只建一次。
   */
  let tickMapCache = null;

  function buildTickMap(track) {
    if (tickMapCache && tickMapCache.version === state.version && tickMapCache.trackId === track.id) {
      return tickMapCache.map;
    }
    const pairs = [];
    for (const s of track.segments) {
      const tick = s.source ? Number(s.source.tick) : NaN;
      if (Number.isFinite(tick)) pairs.push([tick, s.startMs]);
    }
    pairs.sort((a, b) => a[0] - b[0]);
    const map = { pairs };
    tickMapCache = { version: state.version, trackId: track.id, map };
    return map;
  }

  function sourceMsFor(track, seg) {
    if (!seg || !seg.source) return null;
    const direct = Number(seg.source.ms);
    if (Number.isFinite(direct)) return direct;
    const tick = Number(seg.source.tick);
    if (!Number.isFinite(tick)) return null;
    const { pairs } = buildTickMap(track);
    if (!pairs.length) return null;
    // 二分找最近的采样点(只要最近的,不做复杂外推)
    let lo = 0;
    let hi = pairs.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (pairs[mid][0] < tick) lo = mid + 1;
      else hi = mid;
    }
    const cand = [pairs[Math.max(0, lo - 1)], pairs[lo]].filter(Boolean);
    let best = cand[0];
    for (const p of cand) if (Math.abs(p[0] - tick) < Math.abs(best[0] - tick)) best = p;
    // 采样点本身就是「tick 对应的原始位置」,直接返回;同一 tick 的多个采样取最小 startMs
    let ms = best[1];
    for (const p of pairs) if (p[0] === tick && p[1] < ms) ms = p[1];
    return ms;
  }

  /**
   * 构建吸附候选表(按 ms 升序 + 去重)。
   * 只在 pointerdown 时建一次;拖动过程中每帧只做二分查找 → 帧开销与候选数量无关。
   */
  function buildSnapCandidates(track, m, ignoreIds) {
    const byMs = new Map();
    const add = (ms, type) => {
      const v = Math.round(ms);
      if (!Number.isFinite(v) || v < 0) return;
      const prev = byMs.get(v);
      if (!prev || SNAP_PRIORITY[type] > SNAP_PRIORITY[prev]) byMs.set(v, type);
    };

    // 1) 播放头
    add(state.view.playheadMs, 'playhead');

    // 2) 整秒(整秒在屏幕上不足 6px 时没有吸附意义,直接不加,避免候选爆量)
    if (m.pxPerMs * 1000 >= SNAP_PX) {
      const s0 = Math.ceil(m.t0 / 1000) * 1000;
      for (let t = s0; t <= m.t1 + 1000; t += 1000) add(t, 'second');
    }

    // 3) 其它片段的边界:视口 ±1 屏的范围(视口外的边界吸了也看不见)
    const span = m.t1 - m.t0;
    const near = timeline.segmentsInRange(track.id, m.t0 - span, m.t1 + span);
    for (const s of near) {
      if (ignoreIds.has(s.id)) continue;
      add(s.startMs, 'segment');
      add(s.endMs, 'segment');
    }

    // 4) 紧邻的邻居(即使它在视口外很远,拖动时也要能顶住/吸附)
    const segs = track.segments;
    for (let i = 0; i < segs.length; i++) {
      if (!ignoreIds.has(segs[i].id)) continue;
      for (let k = i - 1; k >= 0; k--) if (!ignoreIds.has(segs[k].id)) { add(segs[k].endMs, 'segment'); break; }
      for (let k = i + 1; k < segs.length; k++) if (!ignoreIds.has(segs[k].id)) { add(segs[k].startMs, 'segment'); break; }
    }

    // 5) 被拖动片段自己的原始 MIDI 时间(吸回原位置)
    for (const s of segs) {
      if (!ignoreIds.has(s.id)) continue;
      const ms = sourceMsFor(track, s);
      if (ms != null) add(ms, 'source');
    }

    const list = Array.from(byMs, ([ms, type]) => ({ ms, type })).sort((a, b) => a.ms - b.ms);
    return list;
  }

  /** 在有序候选表里找离 ms 最近且在 tol 内的候选 */
  function nearestCandidate(sorted, ms, tol) {
    if (!sorted.length) return null;
    let lo = 0;
    let hi = sorted.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid].ms < ms) lo = mid + 1;
      else hi = mid;
    }
    const cands = [sorted[lo - 1], sorted[lo], sorted[lo + 1]].filter(Boolean);
    let best = null;
    for (const c of cands) {
      const d = Math.abs(c.ms - ms);
      if (d <= tol && (!best || d < Math.abs(best.ms - ms))) best = c;
    }
    return best;
  }

  /* ------------------------------------------------------------------ *
   * 指针:按下
   * ------------------------------------------------------------------ */

  function onPointerDown(e) {
    if (detached) return;
    if (e.button !== 0) return;             // 只处理左键
    if (isEditableTarget(e.target)) return; // 就地编辑框里的点击不抢
    // 舞台工具栏 / 滚动条上的按下不该被当成时间轴操作
    if (!pointInCanvas(e)) return;
    const m = timeline.metrics();
    const p = localPoint(e);

    // —— 标尺区:拖播放头 ——
    if (p.y < m.rulerH) {
      mode = 'scrub';
      sess = { pointerId: e.pointerId };
      e.preventDefault();
      state.setView({ playheadMs: Math.max(0, Math.round(m.xToTime(p.x))) });
      return;
    }

    const hit = timeline.hitTest(p.x, p.y);
    if (!hit || !hit.segmentId) {
      // —— 空白处:框选 ——
      mode = 'marquee';
      const additive = e.shiftKey || e.ctrlKey || e.metaKey;
      sess = { x0: p.x, y0: p.y, x1: p.x, y1: p.y, additive, pointerId: e.pointerId };
      if (!additive) state.select(null, [], 'replace');
      timeline.setPreview({ kind: 'marquee', marquee: { x0: p.x, y0: p.y, x1: p.x, y1: p.y } });
      scheduleRender();
      e.preventDefault();
      return;
    }

    const t = state.trackById(hit.trackId);
    if (!t) return;

    const already = state.selection.trackId === hit.trackId
      && state.selection.segmentIds.includes(hit.segmentId);

    if (e.shiftKey || e.ctrlKey || e.metaKey) {
      state.select(hit.trackId, [hit.segmentId], 'toggle');
      if (!state.selection.segmentIds.includes(hit.segmentId)) { mode = 'idle'; sess = null; return; }  // 刚被取消选中:只当点击
    } else if (!already) {
      state.select(hit.trackId, [hit.segmentId], 'replace');
    }

    if (t.locked) {   // 锁定轨:能选,不能拖
      mode = 'idle';
      sess = null;
      return;
    }

    const ids = state.selection.segmentIds.slice();
    const originals = new Map();
    for (const id of ids) {
      const s = state.segmentById(hit.trackId, id);
      if (s) originals.set(id, { startMs: s.startMs, endMs: s.endMs });
    }
    if (!originals.size) { mode = 'idle'; sess = null; return; }

    const edgeMode = hit.zone === 'left' || hit.zone === 'right';
    mode = 'drag';
    sess = {
      pointerId: e.pointerId,
      trackId: hit.trackId,
      track: t,
      zone: hit.zone,
      mode: edgeMode ? hit.zone : 'body',
      primaryId: hit.segmentId,
      ids: Array.from(originals.keys()),
      originals,
      startX: p.x,
      startY: p.y,
      moved: false,
      deltaMs: 0,
      patches: {},
      snap: null,
      // 只移动/缩放被点中的那一条(拖边缘时),或者整个选区(拖 body)
      movingIds: edgeMode ? [hit.segmentId] : Array.from(originals.keys()),
      bounds: edgeMode
        ? computeEdgeBounds(t, hit.segmentId, hit.zone)
        : computeMoveBounds(t, ids),
      candidates: [],
      candidatesBuilt: false
    };
    e.preventDefault();
  }

  function computeEdgeBounds(track, segmentId, zone) {
    const segs = track.segments;
    const i = segs.findIndex((s) => s.id === segmentId);
    if (i < 0) return { lo: 0, hi: 0 };
    const s = segs[i];
    if (zone === 'left') {
      const prevEnd = i > 0 ? segs[i - 1].endMs : 0;
      return { lo: Math.max(prevEnd, 0) - s.startMs, hi: (s.endMs - MIN_SEGMENT_MS) - s.startMs };
    }
    const nextStart = i + 1 < segs.length ? segs[i + 1].startMs : Infinity;
    return { lo: (s.startMs + MIN_SEGMENT_MS) - s.endMs, hi: nextStart - s.endMs };
  }

  /* ------------------------------------------------------------------ *
   * 指针:移动
   * ------------------------------------------------------------------ */

  function onPointerMove(e) {
    if (detached || mode === 'idle' || !sess) {
      updateCursorHover(e);
      return;
    }
    const m = timeline.metrics();
    const p = localPoint(e);

    if (mode === 'scrub') {
      state.setView({ playheadMs: Math.max(0, Math.round(m.xToTime(p.x))) });
      return;
    }

    if (mode === 'marquee') {
      sess.x1 = p.x;
      sess.y1 = p.y;
      timeline.setPreview({ kind: 'marquee', marquee: { x0: sess.x0, y0: sess.y0, x1: sess.x1, y1: sess.y1 } });
      scheduleRender();
      return;
    }

    if (mode !== 'drag') return;

    const dx = p.x - sess.startX;
    if (!sess.moved && Math.abs(dx) < DRAG_THRESHOLD_PX && Math.abs(p.y - sess.startY) < DRAG_THRESHOLD_PX) return;
    sess.moved = true;

    // —— 跨轨道:纵向拖到别的泳道就把片段挪过去 ——
    // 只对「整段平移」生效:拖左右边缘是改时长,换了轨就没有意义。
    if (sess.mode === 'body') {
      const lane = m.laneAtY(p.y);
      // 锁定的目标轨不接受落点(和源轨锁定时干脆不能拖是两回事)
      const ok = lane && lane.id !== sess.trackId && !(state.trackById(lane.id) || {}).locked;
      sess.dropTrackId = ok ? lane.id : null;
    } else {
      sess.dropTrackId = null;
    }

    computeDragPreview(dx, m, e.altKey);
    setDragPreview();
    scheduleRender();
  }

  function updateCursorHover(e) {
    if (!canvasEl.style || mode !== 'idle') return;
    const p = localPoint(e);
    const m = timeline.metrics();
    let next = 'default';
    const hit = timeline.hitTest(p.x, p.y);
    if (p.y < m.rulerH) {
      next = 'ew-resize';
    } else if (hit) {
      const t = state.trackById(hit.trackId);
      next = t && t.locked ? 'not-allowed' : (hit.zone === 'left' || hit.zone === 'right' ? 'ew-resize' : 'grab');
    }
    if (canvasEl.style.cursor !== next) canvasEl.style.cursor = next;   // 避免每次 move 都写 style
  }

  /**
   * 计算预览态(不碰模型!)。全部结果写进 sess.patches / sess.snap。
   * 拖动被 clamp 在 [bounds.lo, bounds.hi] 内 —— 因此预览和最终提交都不可能产生重叠。
   */
  function computeDragPreview(dxPx, m, altKey) {
    const raw = dxPx / m.pxPerMs;
    let delta = Math.round(clamp(raw, sess.bounds.lo, sess.bounds.hi));
    let snap = null;

    if (!altKey) {
      if (!sess.candidatesBuilt) {
        sess.candidatesBuilt = true;
        sess.candidates = buildSnapCandidates(sess.track, m, new Set(sess.movingIds));
      }
      const tol = SNAP_PX / m.pxPerMs;
      const edges = [];
      if (sess.mode === 'body') {
        // 整段移动:以「手里那一条」的起止边为主,再加上整个选区的外沿(最多 4 个候选边),
        // 避免选中几百条时每帧做几千次二分。
        const primary = sess.originals.get(sess.primaryId);
        let minStart = Infinity;
        let maxEnd = -Infinity;
        for (const id of sess.movingIds) {
          const o = sess.originals.get(id);
          if (!o) continue;
          if (o.startMs < minStart) minStart = o.startMs;
          if (o.endMs > maxEnd) maxEnd = o.endMs;
        }
        if (primary) edges.push(primary.startMs + delta, primary.endMs + delta);
        if (Number.isFinite(minStart)) edges.push(minStart + delta);
        if (Number.isFinite(maxEnd)) edges.push(maxEnd + delta);
      } else if (sess.mode === 'left') {
        const o = sess.originals.get(sess.primaryId);
        if (o) edges.push(o.startMs + delta);
      } else {
        const o = sess.originals.get(sess.primaryId);
        if (o) edges.push(o.endMs + delta);
      }
      let best = null;
      for (const v of edges) {
        const c = nearestCandidate(sess.candidates, v, tol);
        if (!c) continue;
        const d = c.ms - v;
        if (!best || Math.abs(d) < Math.abs(best.d)) best = { d, ms: c.ms, type: c.type };
      }
      if (best) {
        const snapped = Math.round(clamp(delta + best.d, sess.bounds.lo, sess.bounds.hi));
        if (snapped !== delta) delta = snapped;
        snap = { ms: best.ms, type: best.type, label: SNAP_LABEL[best.type] || '' };
      }
    }

    sess.deltaMs = delta;
    sess.snap = snap;

    const patches = {};
    for (const id of sess.movingIds) {
      const o = sess.originals.get(id);
      if (!o) continue;
      if (sess.mode === 'body') {
        patches[id] = { startMs: o.startMs + delta, endMs: o.endMs + delta };
      } else if (sess.mode === 'left') {
        patches[id] = { startMs: o.startMs + delta, endMs: o.endMs };
      } else {
        patches[id] = { startMs: o.startMs, endMs: o.endMs + delta };
      }
    }
    sess.patches = patches;
  }

  /* ------------------------------------------------------------------ *
   * 指针:松开 / 取消
   * ------------------------------------------------------------------ */

  function onPointerUp(e) {
    if (detached) return;
    if (mode === 'idle') return;
    const wasMode = mode;
    const s = sess;
    mode = 'idle';
    sess = null;

    if (wasMode === 'scrub') { renderNow(); return; }

    if (wasMode === 'marquee') {
      clearPreview();
      applyMarquee(s, e);
      renderNow();
      return;
    }

    if (wasMode === 'drag') {
      clearPreview();
      if (s && s.moved) commitDrag(s);
      else if (s && !e.shiftKey && !e.ctrlKey && !e.metaKey && s.mode === 'body') {
        // 没移动:当成点击,把选区收缩到点中的那一条
        if (state.selection.segmentIds.length !== 1 || state.selection.segmentIds[0] !== s.primaryId) {
          state.select(s.trackId, [s.primaryId], 'replace');
        }
      }
      renderNow();
    }
  }

  /** 松手:唯一一次提交。一次拖动 = 一次状态变更 = 一条撤销记录 */
  function commitDrag(s) {
    // —— 跨轨移动 ——
    if (s.dropTrackId && s.dropTrackId !== s.trackId) {
      // 时间与换轨必须在**同一次** state 变更里完成:
      // 先 applyPatches 改时间、再 moveSegments 换轨的话会留下两条撤销记录,
      // 用户按一次 Ctrl+Z 只退回一半。
      state.moveSegments(s.trackId, s.movingIds, s.dropTrackId, s.patches);
      return;
    }

    const ops = [];
    for (const id of s.movingIds) {
      const p = s.patches[id];
      const o = s.originals.get(id);
      if (!p || !o) continue;
      if (p.startMs === o.startMs && p.endMs === o.endMs) continue;
      ops.push({ trackId: s.trackId, segmentId: id, patch: { startMs: p.startMs, endMs: p.endMs } });
    }
    if (ops.length) state.applyPatches(ops);
  }

  function onPointerCancel() {
    if (mode === 'idle') return;
    mode = 'idle';
    sess = null;
    clearPreview();
    renderNow();
  }

  /** 框选:只判定与选框相交的泳道,选区落在其中一条轨上(契约里 selection 是单轨的) */
  function applyMarquee(s, e) {
    if (!s) return;
    const x0 = Math.min(s.x0, s.x1);
    const x1 = Math.max(s.x0, s.x1);
    const y0 = Math.min(s.y0, s.y1);
    const y1 = Math.max(s.y0, s.y1);
    const m = timeline.metrics();
    const hitsOf = (lane) => {
      const ids = [];
      for (const seg of timeline.segmentsInRange(lane.id, m.xToTime(x0), m.xToTime(x1))) {
        const r = timeline.segmentRect(lane.id, seg.id);
        if (r && r.x + r.w >= x0 && r.x <= x1) ids.push(seg.id);
      }
      return ids;
    };
    const inBox = m.lanes.filter((lane) => !(lane.y + lane.h < y0 || lane.y > y1));
    // 优先用「鼠标按下的那条泳道」,其次用最上面一条有命中的泳道
    const startLane = m.laneAtY(s.y0);
    let anchorTrackId = null;
    let anchorIds = [];
    if (startLane && inBox.some((l) => l.id === startLane.id)) {
      const ids = hitsOf(startLane);
      if (ids.length) { anchorTrackId = startLane.id; anchorIds = ids; }
    }
    if (!anchorTrackId) {
      for (const lane of inBox) {
        const ids = hitsOf(lane);
        if (ids.length) { anchorTrackId = lane.id; anchorIds = ids; break; }
      }
    }
    if (!anchorTrackId) {
      if (!s.additive) state.select(null, [], 'replace');
      return;
    }
    state.select(anchorTrackId, anchorIds, s.additive ? 'add' : 'replace');
  }

  /* ------------------------------------------------------------------ *
   * 双击:就地改文本
   * ------------------------------------------------------------------ */

  function onDoubleClick(e) {
    if (detached) return;
    const p = localPoint(e);
    const hit = timeline.hitTest(p.x, p.y);
    if (!hit || !hit.segmentId) return;
    const t = state.trackById(hit.trackId);
    if (!t || t.locked) return;
    openTextEditor(hit.trackId, hit.segmentId);
  }

  let editorEl = null;

  function closeEditor(save) {
    if (!editorEl) return;
    const { input, trackId, segmentId, original } = editorEl;
    editorEl = null;
    const value = input.value;
    try { input.remove(); } catch { /* ignore */ }
    if (save && value !== original) {
      state.updateSegment(trackId, segmentId, { text: value });   // 一次编辑 = 一条撤销记录
    }
    scheduleRender();
  }

  function openTextEditor(trackId, segmentId) {
    closeEditor(true);
    const seg = state.segmentById(trackId, segmentId);
    const rect = timeline.segmentRect(trackId, segmentId);
    if (!seg || !rect) return;
    const box = canvasEl.getBoundingClientRect();
    const input = document.createElement('input');
    input.type = 'text';
    input.value = seg.text ?? '';
    input.className = 'timeline-inline-editor';
    const w = Math.max(72, Math.min(Math.max(rect.w, 120), 360));
    Object.assign(input.style, {
      position: 'fixed',
      left: `${Math.round(box.left + Math.max(0, rect.x))}px`,
      top: `${Math.round(box.top + rect.y + 3)}px`,
      width: `${Math.round(w)}px`,
      height: `${Math.round(rect.h - 6)}px`,
      zIndex: '9999',
      boxSizing: 'border-box',
      padding: '0 6px',
      margin: '0',
      border: '2px solid #ffd166',
      borderRadius: '5px',
      background: '#101319',
      color: '#eaf1ff',
      font: '12px system-ui, "Segoe UI", "Microsoft YaHei", sans-serif',
      outline: 'none'
    });
    document.body.appendChild(input);
    editorEl = { input, trackId, segmentId, original: seg.text ?? '' };
    input.focus();
    input.select();
    input.addEventListener('keydown', (ev) => {
      ev.stopPropagation();
      if (ev.key === 'Enter') { ev.preventDefault(); closeEditor(true); }
      else if (ev.key === 'Escape') { ev.preventDefault(); closeEditor(false); }
    });
    input.addEventListener('blur', () => closeEditor(true));
    scheduleRender();
  }

  /* ------------------------------------------------------------------ *
   * 滚轮:平移 / Ctrl+滚轮以鼠标为锚点缩放
   * ------------------------------------------------------------------ */

  function onWheel(e) {
    if (detached) return;
    const m = timeline.metrics();
    const p = localPoint(e);
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? Math.max(1, m.height) : 1;
    e.preventDefault();

    if (e.ctrlKey || e.metaKey) {
      // 以鼠标为锚点缩放:光标下的时间保持不动
      const anchorMs = m.xToTime(p.x);
      const factor = e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
      const pxPerMs = clamp(m.pxPerMs * factor, MIN_ZOOM_OUT, MAX_ZOOM_IN);
      if (pxPerMs === m.pxPerMs) return;
      state.setView({ pxPerMs, scrollMs: Math.max(0, Math.round(anchorMs - p.x / pxPerMs)) });
      return;
    }

    if (e.shiftKey) {
      // 轨道多的时候纵向滚动泳道
      const maxScrollY = Math.max(0, m.contentHeight - m.height);
      state.setView({ scrollY: clamp(m.scrollY + (e.deltaY * unit), 0, maxScrollY) });
      return;
    }

    const dx = (e.deltaX || 0) * unit || e.deltaY * unit;
    state.setView({ scrollMs: Math.max(0, state.view.scrollMs + dx / m.pxPerMs) });
  }

  /* ------------------------------------------------------------------ *
   * 键盘
   * ------------------------------------------------------------------ */

  function zoomBy(factor) {
    const m = timeline.metrics();
    const anchorX = m.width / 2;
    const anchorMs = m.xToTime(anchorX);
    const pxPerMs = clamp(m.pxPerMs * factor, MIN_ZOOM_OUT, MAX_ZOOM_IN);
    if (pxPerMs === m.pxPerMs) return;
    state.setView({ pxPerMs, scrollMs: Math.max(0, Math.round(anchorMs - anchorX / pxPerMs)) });
  }

  function nudge(dir, big) {
    const track = selectedTrack();
    if (!track || track.locked) return;
    const ids = selectedIds();
    if (!ids.length) return;
    const step = big ? NUDGE_BIG_MS : NUDGE_MS;
    const bounds = computeMoveBounds(track, ids);
    const delta = clamp(dir * step, bounds.lo, bounds.hi);
    if (!delta) return;
    const ops = [];
    for (const id of ids) {
      const s = state.segmentById(track.id, id);
      if (!s) continue;
      ops.push({ trackId: track.id, segmentId: id, patch: { startMs: s.startMs + delta, endMs: s.endMs + delta } });
    }
    if (ops.length) state.applyPatches(ops);    // 一次位移 = 一条撤销记录
  }

  function setEdgeAtPlayhead(which) {
    const track = selectedTrack();
    if (!track || track.locked) return;
    const ids = selectedIds();
    if (!ids.length) return;
    const ph = state.view.playheadMs;
    const ops = [];
    for (const id of ids) {
      const s = state.segmentById(track.id, id);
      if (!s) continue;
      if (which === 'start') {
        const startMs = Math.max(0, Math.min(ph, s.endMs - MIN_SEGMENT_MS));
        if (startMs !== s.startMs) ops.push({ trackId: track.id, segmentId: id, patch: { startMs } });
      } else {
        const endMs = Math.max(s.startMs + MIN_SEGMENT_MS, ph);
        if (endMs !== s.endMs) ops.push({ trackId: track.id, segmentId: id, patch: { endMs } });
      }
    }
    if (ops.length) state.applyPatches(ops);
  }

  function onKeyDown(e) {
    if (detached || isEditableTarget(e.target) || e.isComposing) return;
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key;

    if (key === 'Delete' || key === 'Backspace') {
      const track = selectedTrack();
      if (track && !track.locked && state.selection.segmentIds.length) {
        e.preventDefault();
        state.removeSegments(track.id, state.selection.segmentIds);
      }
      return;
    }
    if (mod && (key === 'z' || key === 'Z')) {
      e.preventDefault();
      if (e.shiftKey) state.redo(); else state.undo();
      return;
    }
    if (mod && (key === 'y' || key === 'Y')) { e.preventDefault(); state.redo(); return; }
    if (mod && (key === 'a' || key === 'A')) {
      e.preventDefault();
      const p = state.project;
      if (!p) return;
      const cur = selectedTrack();
      const track = (cur && cur.visible !== false) ? cur : p.tracks.find((t) => t.visible !== false);
      if (track) state.select(track.id, track.segments.map((s) => s.id), 'replace');
      return;
    }
    if (key === 'ArrowLeft' || key === 'ArrowRight') {
      e.preventDefault();
      nudge(key === 'ArrowLeft' ? -1 : 1, e.shiftKey);
      return;
    }
    if (key === '[') { e.preventDefault(); setEdgeAtPlayhead('start'); return; }
    if (key === ']') { e.preventDefault(); setEdgeAtPlayhead('end'); return; }
    if (key === '+' || key === '=') { e.preventDefault(); zoomBy(ZOOM_STEP); return; }
    if (key === '-' || key === '_') { e.preventDefault(); zoomBy(1 / ZOOM_STEP); return; }
    if (key === 'Home') {
      e.preventDefault();
      state.setView({ playheadMs: 0, scrollMs: 0 });
      return;
    }
    if (key === 'End') {
      e.preventDefault();
      const m = timeline.metrics();
      const duration = (state.project && state.project.durationMs) || 0;
      state.setView({
        playheadMs: duration,
        scrollMs: Math.max(0, Math.round(duration - m.width / m.pxPerMs))
      });
      return;
    }
    if (key === ' ') {
      // 没有音频、没有播放(用户明确不要):空格什么都不做,只挡住页面滚动
      e.preventDefault();
      return;
    }
    if (key === 'Escape') {
      if (mode === 'drag' || mode === 'marquee') { onPointerCancel(); return; }
      state.select(null, [], 'replace');
    }
  }

  /* ------------------------------------------------------------------ *
   * 装配 / 拆卸
   * ------------------------------------------------------------------ */

  el.addEventListener('pointerdown', onPointerDown);
  el.addEventListener('dblclick', onDoubleClick);
  el.addEventListener('wheel', onWheel, { passive: false });
  el.addEventListener('dragstart', preventDefault);
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointercancel', onPointerCancel);
  window.addEventListener('keydown', onKeyDown);
  const unsubscribe = state.subscribe(() => scheduleRender());

  function preventDefault(e) { e.preventDefault(); }

  function detach() {
    if (detached) return;
    detached = true;
    closeEditor(false);
    el.removeEventListener('pointerdown', onPointerDown);
    el.removeEventListener('dblclick', onDoubleClick);
    el.removeEventListener('wheel', onWheel);
    el.removeEventListener('dragstart', preventDefault);
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
    window.removeEventListener('pointercancel', onPointerCancel);
    window.removeEventListener('keydown', onKeyDown);
    unsubscribe();
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    if (el.style) el.style.touchAction = prevTouchAction;
    clearPreview();
    timeline.render();
  }

  scheduleRender();

  return {
    detach,
    // 附加:给 ui.js 用的小工具
    cancel: onPointerCancel,
    openTextEditor,
    zoomBy,
    /** 当前交互态(ui.js 可以用它在状态栏提示「吸到了整秒 / 原始时间」) */
    state: () => ({
      mode,
      hasPreview: !!(sess && sess.patches),
      snap: sess && sess.snap ? { ...sess.snap } : null,
      deltaMs: sess ? (sess.deltaMs || 0) : 0,
      targets: sess && sess.movingIds ? sess.movingIds.length : 0,
      bounds: sess && sess.bounds ? { lo: sess.bounds.lo, hi: sess.bounds.hi } : null
    })
  };
}

export default attachInteractions;
