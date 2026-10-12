/**
 * public/js/render_timeline.js —— 时间轴 Canvas 渲染 + 命中测试
 *
 * 契约:INTERFACE.md 第 3 节
 *   createTimeline(canvas, state) -> { render(), hitTest(x, y), resize(), destroy() }
 *
 * 职责边界:**纯绘制 + 命中测试**。不改模型、不绑事件(事件在 interact.js)。
 * canvas 只画时间轴区域(左侧轨道名列由 DOM 负责),所以 canvas 的 x = 0 对应 view.scrollMs。
 *
 * 性能(5000 段要跟手):
 *   1. 水平方向按可见时间窗口裁剪 —— segments 按 startMs 升序,二分定位窗口起点后顺序扫到出窗口为止,
 *      全程只触碰视口内的段,不做全量遍历(见 visibleInWindow 的注释)。
 *   2. 垂直方向只画落在视口里的泳道(轨道多的时候这一步比水平裁剪更省)。
 *   3. 文字只在可见段上 measureText,超宽才二分截断加省略号。
 *   stats() 把「本帧画了几段 / 全量几段」暴露出来,排查性能时可以直接看裁剪有没有生效。
 *
 * 附加方法(setPreview / metrics / segmentRect / stats / segmentsInRange)不属于最小公开接口,
 * 是给 interact.js 与 ui.js 用的;下面四个基础方法的签名保持稳定。
 */

const RULER_H = 26;      // 顶部时间标尺高度
const LANE_GAP = 1;      // 泳道间分隔
const EDGE_PX = 7;       // 片段左右边缘的拖拽热区宽度
const MIN_TEXT_W = 18;

const C = {
  bg: '#14161c',
  rulerBg: '#1d2029',
  rulerLine: '#39404f',
  rulerText: '#98a2b6',
  laneOdd: '#1a1d25',
  laneEven: '#171a22',
  laneLocked: '#1c1a1a',
  laneBorder: '#242936',
  grid: '#232837',
  gridStrong: '#2f3646',
  segLyric: '#2f6fb5',
  segLyricTop: '#3d86d8',
  segMeta: '#4a5162',
  segMetaTop: '#5b6478',
  segText: '#eaf1ff',
  segMetaText: '#cfd6e4',
  segBorder: '#0e1117',
  selected: '#ffd166',
  ghost: 'rgba(255,255,255,0.28)',
  playhead: '#ff4d5e',
  snap: '#ffd166',
  marqueeFill: 'rgba(96,165,250,0.14)',
  marqueeStroke: '#60a5fa',
  hint: '#5b6478'
};

/** 标尺刻度候选(ms),挑第一个「像素宽度 >= minPx」的 */
const TICK_STEPS = [10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 15000, 30000, 60000, 120000, 300000, 600000, 1800000, 3600000];

function pad(n, w = 2) { return String(n).padStart(w, '0'); }

/** ms -> mm:ss / h:mm:ss(.mmm) */
export function formatTime(ms, showMs = false) {
  const t = Math.max(0, Math.round(Number(ms) || 0));
  const h = Math.floor(t / 3600000);
  const m = Math.floor((t % 3600000) / 60000);
  const s = Math.floor((t % 60000) / 1000);
  const tail = showMs ? `.${pad(t % 1000, 3)}` : '';
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}${tail}` : `${pad(m)}:${pad(s)}${tail}`;
}

/**
 * 可见时间窗口裁剪的核心。
 *
 * 为什么这么写:segments 恒为 startMs 升序且互不重叠(数据模型保证)。
 * 先用二分找到第一个 startMs >= t0 的下标,再往前看一格 —— 因为不重叠,
 * 更长的那条「跨过左边界」的段最多只能有一条,所以回退一格就够了,不需要向前扫描全部。
 * 之后从该点顺扫,遇到 startMs > t1 立即 break。整体 O(log n + 视口内段数),
 * 5000 段时每帧碰到的通常只有几十条。
 */
function lowerBoundByStart(segs, t) {
  let lo = 0;
  let hi = segs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (segs[mid].startMs < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function visibleInWindow(segs, t0, t1, out = []) {
  out.length = 0;
  let i = lowerBoundByStart(segs, t0);
  if (i > 0 && segs[i - 1].endMs > t0) i--;   // 跨过左边界的长段(最多一条)
  for (; i < segs.length; i++) {
    const s = segs[i];
    if (s.startMs > t1) break;
    if (s.endMs >= t0) out.push(s);
  }
  return out;
}

/**
 * @param {HTMLCanvasElement} canvas
 * @param {object} state AppState
 * @returns {{render:Function, hitTest:Function, resize:Function, destroy:Function}}
 */
export function createTimeline(canvas, state) {
  const ctx = canvas.getContext('2d');
  let cssW = 0;
  let cssH = 0;
  let dpr = 1;
  let destroyed = false;
  let preview = null;
  /** 复用同一个数组,避免每帧产生垃圾 */
  const scratch = [];
  const stats = { drawn: 0, total: 0, scanned: 0, lanes: 0, frameMs: 0, dpr: 1 };
  /** 渐变对象缓存:同一泳道同一高度只建一次,避免每帧每条段都 new 一个 CanvasGradient */
  const gradCache = new Map();

  function laneGradient(y, h, isMeta) {
    const key = `${Math.round(y)}|${Math.round(h)}|${isMeta ? 'm' : 'l'}`;
    let g = gradCache.get(key);
    if (!g) {
      g = ctx.createLinearGradient(0, y, 0, y + h);
      if (isMeta) { g.addColorStop(0, C.segMetaTop); g.addColorStop(1, C.segMeta); }
      else { g.addColorStop(0, C.segLyricTop); g.addColorStop(1, C.segLyric); }
      gradCache.set(key, g);
    }
    return g;
  }

  /* ---------------- 尺寸 / DPR ---------------- */

  function measure() {
    const w = canvas.clientWidth || canvas.width || 0;
    const h = canvas.clientHeight || canvas.height || 0;
    return { w, h };
  }

  /**
   * DPR 处理:canvas.width/height 是**物理像素**,CSS 尺寸保持不变,
   * 每次 render 都用 setTransform(dpr,...) 把绘图坐标拉回 CSS 像素。
   * 少了这一步,高分屏上文字和线条会发虚(位图被放大 2 倍)。
   */
  function resize() {
    if (destroyed) return;
    const { w, h } = measure();
    dpr = Math.max(1, Math.min(4, window.devicePixelRatio || 1));
    cssW = Math.max(0, w);
    cssH = Math.max(0, h);
    const pw = Math.max(1, Math.round(cssW * dpr));
    const ph = Math.max(1, Math.round(cssH * dpr));
    if (canvas.width !== pw) canvas.width = pw;
    if (canvas.height !== ph) canvas.height = ph;
    gradCache.clear();     // canvas 尺寸变了,缓存的渐变对象作废
    stats.dpr = dpr;
    render();
  }

  /* ---------------- 布局(渲染与交互共用同一份坐标换算) ---------------- */

  function visibleTracks() {
    const p = state.project;
    if (!p || !Array.isArray(p.tracks)) return [];
    return p.tracks.filter((t) => t.visible !== false);
  }

  /**
   * 一帧的几何布局。注意 tracks 只含 visible 的轨(INTERFACE §1:visible=false 则不显示),
   * 泳道序号以「可见轨」为准 —— DOM 轨道名列必须用同一套规则才能对齐。
   */
  function layout() {
    const view = state.view;
    const pxPerMs = view.pxPerMs || 0.05;
    const scrollMs = view.scrollMs || 0;
    const laneH = view.laneHeight || 48;
    const scrollY = view.scrollY || 0;
    const t0 = scrollMs;
    const t1 = scrollMs + (cssW > 0 ? cssW / pxPerMs : 0);
    const tracks = visibleTracks();
    const lanes = [];
    for (let i = 0; i < tracks.length; i++) {
      const y = RULER_H + i * (laneH + LANE_GAP) - scrollY;
      lanes.push({ track: tracks[i], index: i, y, h: laneH, id: tracks[i].id });
    }
    return {
      width: cssW,
      height: cssH,
      rulerH: RULER_H,
      laneH,
      laneGap: LANE_GAP,
      pxPerMs,
      scrollMs,
      scrollY,
      t0,
      t1,
      lanes,
      contentHeight: RULER_H + lanes.length * (laneH + LANE_GAP),
      timeToX: (ms) => (ms - scrollMs) * pxPerMs,
      xToTime: (x) => scrollMs + x / pxPerMs,
      laneAtY: (y) => {
        if (y < RULER_H) return null;
        for (const lane of lanes) {
          if (y >= lane.y && y < lane.y + lane.h) return lane;
        }
        return null;
      },
      laneOfTrack: (trackId) => lanes.find((l) => l.id === trackId) || null
    };
  }

  /** 某条轨在可见窗口内的片段(裁剪入口,渲染与 hitTest 都走它) */
  function segmentsOf(lane, m) {
    return visibleInWindow(lane.track.segments, m.t0, m.t1, scratch);
  }

  /** 片段在屏幕上的矩形(x 可能为负 / 超出宽度,调用方自行裁剪) */
  function rectOf(m, seg, lane) {
    const x = m.timeToX(seg.startMs);
    const w = Math.max(1, (seg.endMs - seg.startMs) * m.pxPerMs);
    return { x, y: lane.y, w, h: lane.h };
  }

  /* ---------------- 文字:超宽二分截断 ---------------- */

  function fitText(text, maxW, font) {
    if (!text) return '';
    ctx.font = font;
    if (ctx.measureText(text).width <= maxW) return text;
    let lo = 0;
    let hi = text.length;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (ctx.measureText(`${text.slice(0, mid)}…`).width <= maxW) lo = mid;
      else hi = mid - 1;
    }
    return lo > 0 ? `${text.slice(0, lo)}…` : '';
  }

  /* ---------------- 绘制 ---------------- */

  function roundRect(x, y, w, h, r) {
    const rr = Math.max(0, Math.min(r, w / 2, h / 2));
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.lineTo(x + w - rr, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
    ctx.lineTo(x + w, y + h - rr);
    ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
    ctx.lineTo(x + rr, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
    ctx.lineTo(x, y + rr);
    ctx.quadraticCurveTo(x, y, x + rr, y);
    ctx.closePath();
  }

  function drawSegment(m, seg, lane, opts = {}) {
    const r = rectOf(m, seg, lane);
    if (r.x + r.w < -2 || r.x > m.width + 2) return false;   // 双保险:真出视口就不画
    const isMeta = seg.kind === 'meta';
    const selected = opts.selected === true;
    const x = Math.max(-4, r.x);
    const w = Math.min(r.w, m.width + 8 - x);
    const y = r.y + 3;
    const h = r.h - 6;

    if (opts.ghost) {
      ctx.save();
      ctx.setLineDash([4, 3]);
      ctx.strokeStyle = C.ghost;
      ctx.lineWidth = 1;
      roundRect(x + 0.5, y + 0.5, Math.max(1, w - 1), h - 1, 5);
      ctx.stroke();
      ctx.restore();
      return true;
    }

    // 底色(上亮下暗,看起来像剪辑软件里的片段块)
    const grad = laneGradient(y, h, isMeta);
    roundRect(x, y, Math.max(1, w), h, 5);
    ctx.fillStyle = grad;
    ctx.fill();

    // 选中:描边 + 顶部高亮条
    if (selected) {
      ctx.save();
      ctx.lineWidth = 2;
      ctx.strokeStyle = C.selected;
      ctx.stroke();
      ctx.restore();
      ctx.fillStyle = C.selected;
      ctx.fillRect(x + 2, y + 1, Math.max(1, w - 4), 2);
    } else {
      ctx.lineWidth = 1;
      ctx.strokeStyle = C.segBorder;
      ctx.stroke();
    }

    // 文本(只有宽度够才画,避免糊成一团)
    if (w >= MIN_TEXT_W) {
      const font = '12px system-ui, "Segoe UI", "Microsoft YaHei", sans-serif';
      const label = fitText(String(seg.text ?? ''), w - 12, font);
      if (label) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(x + 5, y, Math.max(1, w - 10), h);
        ctx.clip();
        ctx.font = font;
        ctx.fillStyle = isMeta ? C.segMetaText : C.segText;
        ctx.textBaseline = 'middle';
        ctx.fillText(label, x + 6, y + h / 2 + 0.5);
        ctx.restore();
      }
    }
    return true;
  }

  function drawRuler(m) {
    ctx.fillStyle = C.rulerBg;
    ctx.fillRect(0, 0, m.width, RULER_H);
    ctx.strokeStyle = C.rulerLine;
    ctx.beginPath();
    ctx.moveTo(0, RULER_H - 0.5);
    ctx.lineTo(m.width, RULER_H - 0.5);
    ctx.stroke();

    const step = pickStep(m.pxPerMs);
    const showMs = step < 1000;
    const first = Math.floor(m.t0 / step) * step;
    ctx.font = '11px system-ui, "Segoe UI", "Microsoft YaHei", sans-serif';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = C.rulerText;
    ctx.strokeStyle = C.rulerLine;
    ctx.beginPath();
    let count = 0;
    for (let t = first; t <= m.t1 && count < 4000; t += step, count++) {
      if (t < 0) continue;
      const x = Math.round(m.timeToX(t)) + 0.5;
      ctx.moveTo(x, RULER_H - 7);
      ctx.lineTo(x, RULER_H);
      ctx.fillText(formatTime(t, showMs), x + 4, RULER_H / 2 - 1);
    }
    ctx.stroke();
  }

  function drawGrid(m) {
    // 主刻度线贯穿所有泳道
    const step = pickStep(m.pxPerMs);
    const first = Math.floor(m.t0 / step) * step;
    ctx.strokeStyle = C.gridStrong;
    ctx.beginPath();
    let count = 0;
    for (let t = first; t <= m.t1 && count < 4000; t += step, count += 1) {
      if (t < 0) continue;
      const x = Math.round(m.timeToX(t)) + 0.5;
      ctx.moveTo(x, RULER_H);
      ctx.lineTo(x, m.height);
    }
    ctx.stroke();
    // 整秒细线(缩放到能看清时才画)
    if (m.pxPerMs * 1000 >= 8) {
      const s0 = Math.floor(m.t0 / 1000) * 1000;
      ctx.strokeStyle = C.grid;
      ctx.beginPath();
      let n = 0;
      for (let t = s0; t <= m.t1 && n < 4000; t += 1000, n++) {
        if (t < 0 || t % step === 0) continue;
        const x = Math.round(m.timeToX(t)) + 0.5;
        ctx.moveTo(x, RULER_H);
        ctx.lineTo(x, m.height);
      }
      ctx.stroke();
    }
  }

  function pickStep(pxPerMs) {
    for (const s of TICK_STEPS) if (s * pxPerMs >= 64) return s;
    return TICK_STEPS[TICK_STEPS.length - 1];
  }

  function drawLanes(m) {
    let visibleLaneCount = 0;
    for (const lane of m.lanes) {
      if (lane.y + lane.h < RULER_H || lane.y > m.height) continue;   // 垂直裁剪
      visibleLaneCount++;
      ctx.fillStyle = lane.track.locked ? C.laneLocked : (lane.index % 2 ? C.laneOdd : C.laneEven);
      ctx.fillRect(0, lane.y, m.width, lane.h);
      ctx.strokeStyle = C.laneBorder;
      ctx.beginPath();
      ctx.moveTo(0, Math.round(lane.y + lane.h) + 0.5);
      ctx.lineTo(m.width, Math.round(lane.y + lane.h) + 0.5);
      ctx.stroke();
    }
    stats.lanes = visibleLaneCount;
  }

  /**
   * @param previewPatches  拖动预览:segmentId -> {startMs,endMs}
   * @param previewTrackId  被拖片段**原来**所在的轨(原位画虚线幽灵)
   * @param previewDropTrackId 拖到哪条轨(不为空且与原轨不同时,在目标轨上画实心预览)
   */
  function drawSegments(m, selectionSet, previewPatches, previewTrackId, previewDropTrackId) {
    let drawn = 0;
    // total 是「可见轨里的全部段数」,用来和 drawn 对比看裁剪率
    let total = 0;
    // scanned 是这一帧真正"看过"的段数 —— 裁剪生效时它应该约等于视口内段数,而不是总段数
    let scanned = 0;
    for (const lane of m.lanes) total += lane.track.segments.length;
    for (const lane of m.lanes) {
      if (lane.y + lane.h < RULER_H || lane.y > m.height) continue;   // 垂直裁剪:整条泳道不在视口就不扫
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, RULER_H, m.width, Math.max(0, m.height - RULER_H));
      ctx.clip();
      const list = segmentsOf(lane, m);
      scanned += list.length;
      for (const seg of list) {
        const patch = previewPatches && previewPatches[seg.id];
        if (patch && previewTrackId === lane.id) {
          // 拖动预览:原位画虚线幽灵,新位置画实心
          if (drawSegment(m, seg, lane, { ghost: true })) drawn++;
          const moved = { ...seg, startMs: patch.startMs, endMs: patch.endMs };
          if (drawSegment(m, moved, lane, { selected: true })) drawn++;
        } else {
          if (drawSegment(m, seg, lane, { selected: selectionSet.has(seg.id) })) drawn++;
        }
      }
      // 跨轨拖动的目标预览:被拖的片段按新时间画在目标泳道里,让用户看见它会落在哪
      if (previewDropTrackId === lane.id && previewDropTrackId !== previewTrackId && previewPatches) {
        for (const [id, patch] of Object.entries(previewPatches)) {
          if (!patch) continue;
          const src = previewTrackId ? laneTrackSegment(m, previewTrackId, id) : null;
          const base = src || { id, text: '', kind: 'lyric' };
          const moved = { ...base, startMs: patch.startMs, endMs: patch.endMs };
          if (drawSegment(m, moved, lane, { selected: true })) drawn++;
        }
      }
      ctx.restore();
    }
    stats.drawn = drawn;
    stats.total = total;
    stats.scanned = scanned;
  }

  /** 在指定轨里按 id 找一个片段(画跨轨预览时要用它的文本) */
  function laneTrackSegment(m, trackId, segmentId) {
    const lane = m.lanes.find((l) => l.id === trackId);
    if (!lane) return null;
    return lane.track.segments.find((s) => s.id === segmentId) || null;
  }

  function drawSnap(m, snap) {
    if (!snap || !Number.isFinite(snap.ms)) return;
    const x = Math.round(m.timeToX(snap.ms)) + 0.5;
    ctx.save();
    ctx.setLineDash([5, 4]);
    ctx.strokeStyle = C.snap;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, RULER_H);
    ctx.lineTo(x, m.height);
    ctx.stroke();
    ctx.restore();
    // 顶端小标签:告诉用户吸到了什么
    const label = snap.label || '';
    if (label) {
      ctx.font = '10px system-ui, "Segoe UI", "Microsoft YaHei", sans-serif';
      const w = ctx.measureText(label).width + 8;
      const bx = Math.min(Math.max(0, x - w / 2), Math.max(0, m.width - w));
      ctx.fillStyle = C.snap;
      ctx.fillRect(bx, RULER_H + 2, w, 14);
      ctx.fillStyle = '#20242c';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, bx + 4, RULER_H + 9.5);
    }
  }

  function drawMarquee(m, box) {
    if (!box) return;
    const x = Math.min(box.x0, box.x1);
    const y = Math.min(box.y0, box.y1);
    const w = Math.abs(box.x1 - box.x0);
    const h = Math.abs(box.y1 - box.y0);
    ctx.fillStyle = C.marqueeFill;
    ctx.strokeStyle = C.marqueeStroke;
    ctx.lineWidth = 1;
    ctx.fillRect(x, y, w, h);
    ctx.strokeRect(Math.round(x) + 0.5, Math.round(y) + 0.5, Math.round(w), Math.round(h));
  }

  function drawPlayhead(m) {
    const ms = state.view.playheadMs;
    if (!Number.isFinite(ms)) return;
    const x = Math.round(m.timeToX(ms)) + 0.5;
    if (x < -8 || x > m.width + 8) return;
    ctx.strokeStyle = C.playhead;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, m.height);
    ctx.stroke();
    ctx.fillStyle = C.playhead;
    ctx.beginPath();
    ctx.moveTo(x - 5, 0);
    ctx.lineTo(x + 5, 0);
    ctx.lineTo(x, 8);
    ctx.closePath();
    ctx.fill();
  }

  /* ---------------- 主渲染 ---------------- */

  function render() {
    if (destroyed) return;
    const frameStart = performance.now();
    const { w, h } = measure();
    // 设备像素比可能在窗口跨屏时变化(尺寸没变但 dpr 变了),所以每次都核一遍
    const ndpr = Math.max(1, Math.min(4, window.devicePixelRatio || 1));
    const needResize = w !== cssW || h !== cssH || ndpr !== dpr
      || canvas.width !== Math.max(1, Math.round(w * ndpr))
      || canvas.height !== Math.max(1, Math.round(h * ndpr));
    if (needResize) {
      cssW = w;
      cssH = h;
      dpr = ndpr;
      canvas.width = Math.max(1, Math.round(cssW * dpr));
      canvas.height = Math.max(1, Math.round(cssH * dpr));
      gradCache.clear();
      stats.dpr = dpr;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, cssW, cssH);

    const m = layout();
    if (!state.project) {
      drawRuler(m);
      ctx.fillStyle = C.hint;
      ctx.font = '13px system-ui, "Segoe UI", "Microsoft YaHei", sans-serif';
      ctx.textBaseline = 'middle';
      ctx.fillText('没有打开的项目(导入 MIDI 或新建)', 16, RULER_H + 28);
      stats.drawn = 0;
      stats.total = 0;
      stats.lanes = 0;
      stats.frameMs = performance.now() - frameStart;
      return;
    }

    const p = preview && preview.kind === 'drag' ? preview : null;
    const sel = state.selection;
    const selectionSet = sel.trackId
      ? new Set(sel.segmentIds)
      : new Set();

    drawLanes(m);
    drawGrid(m);
    drawSegments(m, selectionSet, p ? p.patches : null, p ? p.trackId : null, p ? p.dropTrackId : null);
    if (preview && preview.snap) drawSnap(m, preview.snap);
    if (preview && preview.marquee) drawMarquee(m, preview.marquee);
    drawRuler(m);
    drawPlayhead(m);

    stats.frameMs = performance.now() - frameStart;
  }

  /* ---------------- 命中测试(同样按可见窗口裁剪) ---------------- */

  /**
   * @returns {{trackId:string, segmentId:string, zone:'body'|'left'|'right'}|null}
   */
  function hitTest(x, y) {
    if (destroyed || !state.project) return null;
    if (!(x >= 0 && x <= cssW && y >= 0 && y <= cssH)) return null;
    const m = layout();
    if (y < m.rulerH) return null;   // 标尺区由交互层单独处理(拖播放头)
    const lane = m.laneAtY(y);
    if (!lane || lane.y + lane.h < m.rulerH) return null;
    // 只在这条泳道的可见窗口里找,不做全量遍历
    const list = segmentsOf(lane, m);
    for (let i = list.length - 1; i >= 0; i--) {
      const seg = list[i];
      const r = rectOf(m, seg, lane);
      if (x >= r.x && x <= r.x + r.w) {
        // 边缘热区:窄片段上要收窄,否则整条都是"边缘",没法拖动位置。
        // 规则:热区不超过片段宽度的 1/4,且片段至少 18px 宽才有边缘区(更窄就整体当 body)。
        let zone = 'body';
        if (r.w >= 18) {
          const edge = Math.min(EDGE_PX, Math.max(3, r.w / 4));
          if (x - r.x <= edge) zone = 'left';
          else if (r.x + r.w - x <= edge) zone = 'right';
        }
        return { trackId: lane.id, segmentId: seg.id, zone };
      }
    }
    return null;
  }

  /** 片段当前的屏幕矩形(就地文本编辑要用它定位输入框);不在视口内返回 null */
  function segmentRect(trackId, segmentId) {
    if (destroyed || !state.project) return null;
    const m = layout();
    const lane = m.laneOfTrack(trackId);
    if (!lane) return null;
    const list = visibleInWindow(lane.track.segments, m.t0, m.t1, []);
    const seg = list.find((s) => s.id === segmentId);
    if (!seg) return null;
    return { ...rectOf(m, seg, lane), startMs: seg.startMs, endMs: seg.endMs };
  }

  /**
   * 某条轨在时间区间 [t0, t1] 内的片段(按同一套二分裁剪,不做全量遍历)。
   * interact.js 用它收吸附候选、框选命中和拖动命中。
   */
  function segmentsInRange(trackId, t0, t1) {
    const p = state.project;
    if (!p) return [];
    const track = p.tracks.find((t) => t.id === trackId);
    if (!track) return [];
    return visibleInWindow(track.segments, Math.min(t0, t1), Math.max(t0, t1), []);
  }

  function setPreview(p) {
    preview = p || null;
    return preview;
  }

  function destroy() {
    destroyed = true;
    preview = null;
    if (ro) { try { ro.disconnect(); } catch { /* ignore */ } }
    ro = null;
    try { ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, canvas.width, canvas.height); } catch { /* ignore */ }
  }

  // 画布尺寸变化自动重算(高分屏 / 面板折叠 / 窗口缩放)
  let ro = null;
  if (typeof ResizeObserver !== 'undefined') {
    ro = new ResizeObserver(() => { if (!destroyed) resize(); });
    try { ro.observe(canvas); } catch { /* ignore */ }
  }

  resize();

  return {
    // —— 冻结契约 ——
    render,
    hitTest,
    resize,
    destroy,
    // —— 附加 ——
    canvasEl: canvas,
    setPreview,
    metrics: layout,
    stats: () => ({ ...stats }),
    segmentRect,
    segmentsInRange,
    formatTime
  };
}

export default createTimeline;
