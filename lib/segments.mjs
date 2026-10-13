/**
 * lib/segments.mjs —— 音节 → 句子(断句)+ 拆分 / 合并 / 平移 / 归一化
 *
 * 所有函数都是纯函数:不碰 DOM / 网络 / 文件系统,且**不修改入参**(返回新对象)。
 *
 * 约定:
 * - Segment.endMs > startMs 恒成立,违法时补 `endMs = startMs + 200`。
 * - 数值判空统一用 Number.isFinite(),禁止 `if (!seg.startMs)` ——
 *   第一个歌词很可能就在 tick 0 = 0ms,真值判断会把合法的 0 当成"未设置"。
 * - 不同轨的音节/片段**绝不互相合并**,也不互相推挤(normalizeSegments 按轨分组)。
 */

/** 断句默认设置(对应 Project.settings 的默认值) */
export const DEFAULT_SETTINGS = Object.freeze({
  gapMs: 600,
  breakChars: '。!?…—、,.！？',
  minDurationMs: 200,
});

/** endMs <= startMs 时的补齐量(数据模型硬约定) */
const FALLBACK_DURATION_MS = 200;

/** 段尾音节的最小基准时长 */
const TAIL_FLOOR_MS = 200;

/** AIGC 合规 JSON:永不是歌词(防御性过滤,解析层已经滤过一遍) */
const AIGC_JSON_RE = /^\s*\{\s*"AIGC"/;

let segmentIdCounter = 0;

/** 生成全局唯一的片段 id(形如 s_1)。拆分/合并/新增都用它,保证唯一性。 */
export function nextSegmentId() {
  segmentIdCounter += 1;
  return `s_${segmentIdCounter}`;
}

function isObj(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function finiteOr(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

function toText(value) {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  return String(value);
}

function clampInt(value, min, max) {
  const n = Math.round(finiteOr(value, min));
  return Math.min(Math.max(n, min), max);
}

/** 合并文本:纯拼接;只有两侧都是 ASCII 字母/数字时才补一个空格(拼音歌词 "qi"+"hei" → "qi hei") */
function joinText(parts) {
  let out = '';
  for (const part of parts) {
    const p = toText(part);
    if (p === '') continue;
    if (out === '') {
      out = p;
      continue;
    }
    const needSpace = /[A-Za-z0-9]$/.test(out) && /^[A-Za-z0-9]/.test(p);
    out += needSpace ? ` ${p}` : p;
  }
  return out;
}

/** 结尾是否是断句标点(忽略行尾空白) */
function endsWithBreakChar(text, breakChars) {
  if (typeof breakChars !== 'string' || breakChars === '') return false;
  const trimmed = toText(text).replace(/\s+$/, '');
  if (trimmed === '') return false;
  return breakChars.includes(trimmed.slice(-1));
}

/** 轨分组键:优先 trackId(projectToSegments 会带上),其次 source.trackIndex */
function trackKeyOf(seg) {
  if (seg && typeof seg.trackId === 'string' && seg.trackId !== '') return `id:${seg.trackId}`;
  const ti = seg?.source?.trackIndex;
  if (Number.isFinite(ti)) return `ti:${ti}`;
  return '__default__';
}

function trackIndexOf(seg) {
  const ti = seg?.source?.trackIndex;
  return Number.isFinite(ti) ? ti : 0;
}

// ---------------------------------------------------------------------------
// 归一化
// ---------------------------------------------------------------------------

/** 把任意脏数据整成合法的 words 数组(无有效项时返回 null) */
function coerceWords(raw) {
  if (!Array.isArray(raw)) return null;
  const words = [];
  for (const w of raw) {
    if (!isObj(w)) continue;
    const startMs = Math.max(0, Math.round(finiteOr(w.startMs, 0)));
    const endMs = Math.max(startMs, Math.round(finiteOr(w.endMs, startMs)));
    words.push({ ...w, text: toText(w.text), startMs, endMs });
  }
  if (words.length === 0) return null;
  words.sort((a, b) => a.startMs - b.startMs);
  return words;
}

function coerceSegment(raw) {
  const startMs = Math.max(0, Math.round(finiteOr(raw.startMs, 0)));
  let endMs = Math.round(finiteOr(raw.endMs, startMs + FALLBACK_DURATION_MS));
  if (!(endMs > startMs)) endMs = startMs + FALLBACK_DURATION_MS; // endMs > startMs 恒成立
  const source = isObj(raw.source)
    ? { ...raw.source, trackIndex: Math.max(0, Math.round(finiteOr(raw.source.trackIndex, 0))), tick: Math.max(0, Math.round(finiteOr(raw.source.tick, 0))) }
    : null;
  return {
    ...raw,
    id: typeof raw.id === 'string' && raw.id !== '' ? raw.id : nextSegmentId(),
    startMs,
    endMs,
    text: toText(raw.text),
    kind: raw.kind === 'meta' ? 'meta' : 'lyric',
    source,
    words: coerceWords(raw.words),
  };
}

/**
 * 保证升序、不重叠、endMs > startMs(不修改入参)。
 * - 升序:按 startMs 排序(稳定排序,同值保持原顺序)
 * - 重叠:同一条轨内把**后一条整体后推**(保留两条的文本与时长,不丢内容);words 同步平移
 * - 不同轨之间允许重叠(不同泳道本来就并行)
 */
export function normalizeSegments(segments) {
  const list = Array.isArray(segments) ? segments.filter(isObj) : [];
  const groups = new Map();
  for (const raw of list) {
    const key = trackKeyOf(raw);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(coerceSegment(raw));
  }

  const usedIds = new Set();
  const out = [];
  for (const group of groups.values()) {
    group.sort((a, b) => a.startMs - b.startMs);
    let prev = null;
    for (const seg of group) {
      if (usedIds.has(seg.id)) seg.id = nextSegmentId();
      usedIds.add(seg.id);

      if (prev && seg.startMs < prev.endMs) {
        // 重叠:整体后推到前一条之后,并**保留自身时长**(words 同步平移)
        const delta = prev.endMs - seg.startMs;
        seg.startMs += delta;
        seg.endMs += delta;
        if (Array.isArray(seg.words)) {
          seg.words = seg.words.map((w) => ({ ...w, startMs: w.startMs + delta, endMs: w.endMs + delta }));
        }
      }
      if (!(seg.endMs > seg.startMs)) seg.endMs = seg.startMs + FALLBACK_DURATION_MS;
      prev = seg;
      out.push(seg);
    }
  }
  out.sort((a, b) => a.startMs - b.startMs);
  return out;
}

/** settings 补全 + 校验(脏数据不抛错) */
export function normalizeSettings(settings) {
  const s = isObj(settings) ? settings : {};
  return {
    gapMs: Math.max(0, Math.round(finiteOr(s.gapMs, DEFAULT_SETTINGS.gapMs))),
    breakChars: typeof s.breakChars === 'string' ? s.breakChars : DEFAULT_SETTINGS.breakChars,
    minDurationMs: Math.max(0, Math.round(finiteOr(s.minDurationMs, DEFAULT_SETTINGS.minDurationMs))),
  };
}

// ---------------------------------------------------------------------------
// 断句
// ---------------------------------------------------------------------------

function wordsOfRun(run) {
  return run.words.map((w) => ({ tick: w.tick, text: w.text, startMs: w.startMs, endMs: w.endMs }));
}

function segmentFromRun(run) {
  const words = run.words;
  const first = words[0];
  const last = words[words.length - 1];
  return {
    id: nextSegmentId(),
    startMs: first.startMs,
    endMs: last.endMs,
    text: joinText(words.map((w) => w.text)),
    kind: 'lyric',
    source: { trackIndex: run.trackIndex, tick: finiteOr(first.tick, first.startMs) },
    // words 的契约字段是 text/startMs/endMs;额外带上 tick(原始 MIDI 位置),
    // 供 regroupSegments 与"吸附回原始时间"使用,导出器不依赖它。
    words: wordsOfRun(run),
  };
}

/**
 * 音节 → 句子。
 * 规则:
 *  1. 相邻音节间隔 > settings.gapMs 则断开
 *  2. 上一个音节的文本以 settings.breakChars 中的字符结尾则断开
 *  3. 每段时长不足 settings.minDurationMs 时向后补齐(但不与邻段重叠)
 * 段内保留逐字时间到 words。
 *
 * 音节结束时间:后面还有同轨音节且间隔 <= gapMs 时,本音节一直持续到下一个音节开始;
 * 否则(断句点/最后一个音节)持续 max(minDurationMs, 200) —— 否则最后一句会被拉长到
 * 下一次开口,字幕挂在屏幕上不动。
 */
export function buildSegments(lyricEvents, settings) {
  const cfg = normalizeSettings(settings);
  const list = Array.isArray(lyricEvents) ? lyricEvents : [];

  const syllables = [];
  for (const ev of list) {
    if (!isObj(ev)) continue;
    const text = toText(ev.text);
    if (text.trim() === '') continue; // 空文本音节不参与断句
    if (AIGC_JSON_RE.test(text)) continue; // 防御:AIGC 合规 JSON 永不是歌词
    const ms = Number.isFinite(ev.ms) ? ev.ms : Number.isFinite(ev.tick) ? ev.tick : NaN;
    if (!Number.isFinite(ms)) continue;
    const trackIndex = Number.isFinite(ev.trackIndex)
      ? ev.trackIndex
      : Number.isFinite(ev.source?.trackIndex)
        ? ev.source.trackIndex
        : 0;
    syllables.push({
      order: syllables.length,
      tick: Number.isFinite(ev.tick) ? ev.tick : Math.max(0, Math.round(ms)),
      startMs: Math.max(0, Math.round(ms)),
      text,
      trackIndex,
    });
  }

  const groups = new Map();
  for (const s of syllables) {
    if (!groups.has(s.trackIndex)) groups.set(s.trackIndex, []);
    groups.get(s.trackIndex).push(s);
  }

  const runs = [];
  for (const [trackIndex, group] of groups) {
    group.sort((a, b) => a.startMs - b.startMs || a.order - b.order);

    // 规则 1 + 2:先定断点,再算每个音节的结束时间(段尾音节要单独处理)
    const brk = group.map((s, i) => {
      if (i === 0) return false;
      const prev = group[i - 1];
      if (s.startMs - prev.startMs > cfg.gapMs) return true;
      return endsWithBreakChar(prev.text, cfg.breakChars);
    });

    const words = group.map((s, i) => {
      const next = group[i + 1];
      const endsRun = !next || brk[i + 1];
      const tail = Math.max(cfg.minDurationMs, TAIL_FLOOR_MS);
      let endMs = endsRun ? s.startMs + tail : next.startMs;
      if (!(endMs > s.startMs)) endMs = s.startMs + 1;
      return { tick: s.tick, text: s.text, startMs: s.startMs, endMs };
    });

    let current = null;
    const trackRuns = [];
    group.forEach((s, i) => {
      if (!current || brk[i]) {
        current = { trackIndex, words: [] };
        trackRuns.push(current);
        runs.push(current);
      }
      current.words.push(words[i]);
    });

    // 规则 3:按轨内的段序列补齐时长,并保证不与邻段重叠
    for (let i = 0; i < trackRuns.length; i++) {
      const run = trackRuns[i];
      const start = run.words[0].startMs;
      const nextStart = i + 1 < trackRuns.length ? trackRuns[i + 1].words[0].startMs : Infinity;
      let end = run.words[run.words.length - 1].endMs;
      const minEnd = start + cfg.minDurationMs;
      if (end < minEnd) end = minEnd; // 向外补齐
      if (end > nextStart) end = nextStart; // 不与邻段重叠
      if (!(end > start)) end = start + FALLBACK_DURATION_MS;
      run.endMs = end;
    }
  }

  const segments = runs.map((run) => {
    const seg = segmentFromRun(run);
    if (Number.isFinite(run.endMs) && run.endMs !== seg.endMs) seg.endMs = run.endMs;
    if (!(seg.endMs > seg.startMs)) seg.endMs = seg.startMs + FALLBACK_DURATION_MS;
    return seg;
  });

  return normalizeSegments(segments);
}

// ---------------------------------------------------------------------------
// 重新断句(保留用户手改过的段)
// ---------------------------------------------------------------------------

/** 用户手改过 / 无法从音节重建的段:原样保留 */
function isClaimed(seg) {
  if (seg.claimed === true) return true;
  if (!isObj(seg.source)) return true; // 手工新建的段没有原始位置
  const ws = Array.isArray(seg.words) ? seg.words.filter(isObj) : [];
  if (ws.length > 0) {
    const first = ws[0];
    const last = ws[ws.length - 1];
    if (Number.isFinite(first.startMs) && first.startMs !== seg.startMs) return true; // 被拖动过
    if (Number.isFinite(last.endMs) && last.endMs !== seg.endMs) return true; // 被拉伸过
  }
  return false;
}

/**
 * 用当前 settings 重新断句:
 * - 未手改过的段("pristine":时间仍与其 words 对齐)拆回音节,重新按新 gapMs/breakChars 分组
 * - 手改过的段(claimed:显式 claimed 标记 / 无 source / 时间与 words 不匹配)原样保留,
 *   并把新分组的结果让开它们占用的时间区间
 */
export function regroupSegments(segments, settings) {
  const cfg = normalizeSettings(settings);
  const list = Array.isArray(segments) ? segments.filter(isObj) : [];
  if (list.length === 0) return [];

  const claimedRaw = [];
  const syllables = [];
  for (const raw of list) {
    if (isClaimed(raw)) {
      claimedRaw.push(raw);
      continue;
    }
    const trackIndex = trackIndexOf(raw);
    const ws = Array.isArray(raw.words) ? raw.words.filter(isObj) : null;
    if (ws && ws.length > 0) {
      for (const w of ws) {
        syllables.push({
          tick: Number.isFinite(w.tick) ? w.tick : w.startMs,
          ms: w.startMs,
          text: toText(w.text),
          trackIndex,
        });
      }
    } else {
      syllables.push({
        tick: Number.isFinite(raw.tick) ? raw.tick : raw.startMs,
        ms: raw.startMs,
        text: toText(raw.text),
        trackIndex,
      });
    }
  }

  const claimed = normalizeSegments(claimedRaw);
  const regenerated = buildSegments(syllables, cfg);

  const out = claimed.map((s) => ({ ...s }));
  for (const seg of regenerated) {
    const cuts = claimed.filter((c) => trackKeyOf(c) === trackKeyOf(seg));
    if (cuts.length === 0) {
      out.push(seg);
      continue;
    }
    for (const piece of subtractIntervals(seg, cuts)) out.push(piece);
  }
  return normalizeSegments(out);
}

/** 从 seg 中挖掉 cuts 覆盖的时间区间,返回剩下的片段 */
function subtractIntervals(seg, cuts) {
  let pieces = [[seg.startMs, seg.endMs]];
  for (const cut of cuts) {
    if (!(cut.endMs > seg.startMs) || !(cut.startMs < seg.endMs)) continue;
    const next = [];
    for (const [a, b] of pieces) {
      if (cut.endMs <= a || cut.startMs >= b) {
        next.push([a, b]);
        continue;
      }
      if (cut.startMs > a) next.push([a, Math.min(cut.startMs, b)]);
      if (cut.endMs < b) next.push([Math.max(cut.endMs, a), b]);
    }
    pieces = next;
  }
  return pieces
    .filter(([a, b]) => b > a)
    .map(([a, b]) => sliceSegment(seg, a, b, { keepId: a === seg.startMs }));
}

// ---------------------------------------------------------------------------
// 切片 / 拆分 / 合并 / 平移
// ---------------------------------------------------------------------------

function sliceWords(words, from, to) {
  if (!Array.isArray(words)) return [];
  const out = [];
  for (const w of words) {
    if (!isObj(w)) continue;
    const startMs = Math.round(finiteOr(w.startMs, from));
    const endMs = Math.round(finiteOr(w.endMs, startMs));
    if (startMs >= to || endMs <= from) continue;
    const ws = Math.max(from, startMs);
    const we = Math.min(to, endMs);
    out.push({ ...w, startMs: ws, endMs: Math.max(we, ws) });
  }
  return out.sort((a, b) => a.startMs - b.startMs);
}

/** 没有 words 时按时间比例切文本(逐码点切,不会切断代理对) */
function sliceTextByRatio(text, from, to, segStart, segEnd) {
  const chars = Array.from(toText(text));
  if (chars.length === 0) return '';
  const total = Math.max(1, segEnd - segStart);
  const a = clampInt((chars.length * (from - segStart)) / total, 0, chars.length);
  const b = clampInt((chars.length * (to - segStart)) / total, a, chars.length);
  return chars.slice(a, b).join('');
}

function sliceSegment(seg, from, to, opts = {}) {
  const startMs = Math.max(0, Math.round(finiteOr(from, 0)));
  let endMs = Math.round(finiteOr(to, startMs + FALLBACK_DURATION_MS));
  if (!(endMs > startMs)) endMs = startMs + 1; // endMs > startMs 恒成立
  const words = sliceWords(seg.words, startMs, endMs);
  const text = words.length > 0 ? joinText(words.map((w) => w.text)) : sliceTextByRatio(seg.text, startMs, endMs, seg.startMs, seg.endMs);
  const out = {
    ...(typeof seg.trackId === 'string' ? { trackId: seg.trackId } : {}),
    id: opts.keepId ? seg.id : nextSegmentId(),
    startMs,
    endMs,
    text,
    kind: seg.kind === 'meta' ? 'meta' : 'lyric',
    source: startMs === seg.startMs && isObj(seg.source) ? { ...seg.source } : null,
    words: words.length > 0 ? words : null,
  };
  return out;
}

/**
 * 按时间拆分一条,返回 [left, right]。
 * - 两段的 id 唯一:left 保留原 id,right 取新 id
 * - left 保留 source(它的起点仍是原始位置),right.source = null(右半段没有原始位置,
 *   保留会误导"吸附回原始时间")
 * - 文本:有 words 时按 words 归属切;否则按时间比例逐码点切;单字无法切时两侧都留原文
 */
export function splitSegment(seg, atMs) {
  if (!isObj(seg)) throw new Error('splitSegment 需要一条片段');
  const rawStart = Math.max(0, Math.round(finiteOr(seg.startMs, 0)));
  let rawEnd = Math.round(finiteOr(seg.endMs, rawStart + FALLBACK_DURATION_MS));
  if (!(rawEnd > rawStart)) rawEnd = rawStart + FALLBACK_DURATION_MS;

  let cut;
  if (rawEnd - rawStart >= 2) {
    cut = Number.isFinite(atMs) ? Math.round(atMs) : Math.round((rawStart + rawEnd) / 2);
    cut = Math.min(Math.max(cut, rawStart + 1), rawEnd - 1);
  } else {
    cut = rawStart + 1; // 退化段(仅 1ms):左半取整段,右半顺延 1ms
  }

  const left = sliceSegment(seg, rawStart, Math.min(cut, rawEnd), { keepId: true });
  const right = sliceSegment(seg, cut, rawEnd);

  // 文本按拆分点归属
  const chars = Array.from(toText(seg.text));
  const ws = Array.isArray(seg.words) ? seg.words.filter(isObj) : [];
  let leftText;
  let rightText;
  if (ws.length > 0) {
    const lw = ws.filter((w) => finiteOr(w.startMs, -1) < cut);
    const rw = ws.filter((w) => finiteOr(w.startMs, -1) >= cut);
    if (lw.length > 0 && rw.length > 0) {
      leftText = joinText(lw.map((w) => w.text));
      rightText = joinText(rw.map((w) => w.text));
    }
  }
  if (leftText === undefined) {
    if (chars.length >= 2) {
      const n = clampInt((chars.length * (cut - rawStart)) / (rawEnd - rawStart), 1, chars.length - 1);
      leftText = chars.slice(0, n).join('');
      rightText = chars.slice(n).join('');
    } else {
      leftText = toText(seg.text);
      rightText = leftText; // 单字/空文本:两侧都保留,避免出现空字幕
    }
  }
  left.text = leftText;
  right.text = rightText;
  return [left, right];
}

/**
 * 合并相邻两条(必须同轨、时间相邻且不重叠)。
 * - 结果取 a 的 id / startMs,a+b 的文本与 words(缺失一侧用整段合成一个字)
 * - 同轨判定用 trackId / source.trackIndex
 */
export function mergeSegments(a, b) {
  if (!isObj(a) || !isObj(b)) throw new Error('mergeSegments 需要两条片段');
  if (trackKeyOf(a) !== trackKeyOf(b)) {
    throw new Error('mergeSegments:只能合并同一条轨上的片段');
  }
  if (b.startMs < a.startMs) {
    throw new Error('mergeSegments:第二个片段必须在前一个之后(时间相邻)');
  }
  if (b.startMs < a.endMs) {
    throw new Error('mergeSegments:两条片段时间重叠,不能合并');
  }

  const startMs = Math.max(0, Math.round(finiteOr(a.startMs, 0)));
  let endMs = Math.round(finiteOr(Math.max(finiteOr(a.endMs, 0), finiteOr(b.endMs, 0)), startMs + FALLBACK_DURATION_MS));
  if (!(endMs > startMs)) endMs = startMs + FALLBACK_DURATION_MS;

  const aWords = Array.isArray(a.words) ? a.words.filter(isObj) : [];
  const bWords = Array.isArray(b.words) ? b.words.filter(isObj) : [];
  let words = null;
  if (aWords.length > 0 || bWords.length > 0) {
    const head = aWords.length > 0
      ? aWords.map((w) => ({ ...w }))
      : [{ text: toText(a.text), startMs: Math.max(0, Math.round(finiteOr(a.startMs, 0))), endMs: Math.round(finiteOr(a.endMs, startMs)) }];
    const tail = bWords.length > 0
      ? bWords.map((w) => ({ ...w }))
      : [{ text: toText(b.text), startMs: Math.round(finiteOr(b.startMs, endMs)), endMs }];
    words = coerceWords([...head, ...tail]);
  }

  return {
    ...(typeof a.trackId === 'string' ? { trackId: a.trackId } : {}),
    id: typeof a.id === 'string' && a.id !== '' ? a.id : nextSegmentId(),
    startMs,
    endMs,
    text: joinText([a.text, b.text]),
    kind: a.kind === 'meta' && b.kind === 'meta' ? 'meta' : 'lyric',
    source: isObj(a.source) ? { ...a.source } : isObj(b.source) ? { ...b.source } : null,
    words,
  };
}

/**
 * 整体平移(offsetMs 可为负,结果 clamp 到 >= 0)。
 * - 保持相对时间不变:负向平移取 max(offset, -最早片段的 startMs),最早那条落到 0
 * - words 同步平移;**source 不平移**(它记录的是原始 MIDI 位置,正是"吸附回去"的锚点)
 */
export function shiftSegments(segments, offsetMs) {
  const list = Array.isArray(segments) ? segments.filter(isObj) : [];
  if (list.length === 0) return [];
  const offset = Math.round(finiteOr(offsetMs, 0));

  let minStart = Infinity;
  for (const s of list) {
    const start = finiteOr(s.startMs, 0);
    if (start < minStart) minStart = start;
  }
  if (!Number.isFinite(minStart)) minStart = 0;
  const effective = Math.max(offset, -minStart);

  return list.map((s) => {
    const startMs = Math.max(0, Math.round(finiteOr(s.startMs, 0)) + effective);
    let endMs = Math.round(finiteOr(s.endMs, startMs) + effective);
    if (!(endMs > startMs)) endMs = startMs + FALLBACK_DURATION_MS;
    const words = Array.isArray(s.words)
      ? s.words.filter(isObj).map((w) => ({
        ...w,
        startMs: Math.max(0, Math.round(finiteOr(w.startMs, 0)) + effective),
        endMs: Math.max(0, Math.round(finiteOr(w.endMs, 0)) + effective),
      }))
      : null;
    return { ...s, startMs, endMs, words: words && words.length > 0 ? words : null };
  });
}
