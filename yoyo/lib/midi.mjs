/**
 * lib/midi.mjs —— Standard MIDI File(SMF)解析 + tempo map 时间换算
 *
 * 设计约束:
 * - **零依赖、双端可用**:本文件同时被 Node 与浏览器加载
 *   (public/js/importers.js → ../../lib/midi.mjs)。因此**不允许任何静态 `import 'node:fs'`**,
 *   否则浏览器加载整张模块图时会直接失败。parseMidiFile 用 process.getBuiltinModule('node:fs')
 *   在 Node 里惰性取 fs。
 * - **纯函数**:除 parseMidiFile 外不碰文件系统 / DOM / 网络。
 * - **整数毫秒**:数据模型要求 Segment.startMs/endMs 为整数毫秒,SRT/VTT 也只有毫秒精度,
 *   所以 tickToMs 直接四舍五入到毫秒 —— 保证 `tickToMs(midi, ev.tick) === ev.ms` 恒成立。
 *   需要精确原始位置时用 source.tick 回算。
 * - **歌词来源逐轨判定**:0x05 优先;该轨没有 0x05 时,不含 AIGC 的 0x01 兜底为歌词。
 */

const AIGC_JSON_RE = /^\s*\{\s*"AIGC"/;

/** SMF 规范默认速度:120BPM */
const DEFAULT_US_PER_QUARTER = 500000;

/** 变长整数上限:最多 5 字节 */
const MAX_VLQ_BYTES = 5;

/** 文本型 meta 的类型编号 */
const META_TEXT = 0x01;
const META_TRACK_NAME = 0x03;
const META_LYRIC = 0x05;
const META_MARKER = 0x06;
const META_CUE = 0x07;
const META_TEMPO = 0x51;

// ---------------------------------------------------------------------------
// 字节读取小工具
// ---------------------------------------------------------------------------

function toBytes(input) {
  if (input instanceof Uint8Array) return input; // Buffer 也是 Uint8Array
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  if (Array.isArray(input)) return Uint8Array.from(input);
  throw new Error(`parseMidi 需要 Uint8Array / ArrayBuffer / Buffer,收到 ${input === null ? 'null' : typeof input}`);
}

function readU16(b, p) {
  return (b[p] << 8) | b[p + 1];
}

function readU32(b, p) {
  return ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0;
}

function readTag(b, p) {
  return String.fromCharCode(b[p], b[p + 1], b[p + 2], b[p + 3]);
}

/** 变长整数(VLQ)。最多 5 字节,用乘法而不是 << 以免 32 位溢出。 */
function readVarInt(b, pos, limit, what) {
  let value = 0;
  for (let i = 0; i < MAX_VLQ_BYTES; i++) {
    if (pos >= limit) {
      throw new Error(`MIDI 数据不完整:${what}在第 ${pos} 字节处意外结束`);
    }
    const byte = b[pos++];
    value = value * 128 + (byte & 0x7f);
    if ((byte & 0x80) === 0) return { value, pos };
  }
  throw new Error(`MIDI 数据损坏:${what}从第 ${pos} 字节起超过 5 字节上限(变长整数非法)`);
}

/**
 * 文本解码:先按 UTF-8 解,出现替换符 U+FFFD 再用 GBK 兜底(中文 MIDI 常见 GBK)。
 * 浏览器与 Node(全 ICU)都有 TextDecoder,gbk 取不到时退回 UTF-8 结果。
 */
function decodeText(bytes) {
  if (!bytes || bytes.length === 0) return '';
  let utf8 = '';
  try {
    utf8 = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  } catch {
    utf8 = '';
    for (let i = 0; i < bytes.length; i++) utf8 += String.fromCharCode(bytes[i]);
  }
  if (!utf8.includes('\uFFFD')) return stripBom(utf8);
  try {
    const gbk = new TextDecoder('gbk', { fatal: false }).decode(bytes);
    return stripBom(gbk || utf8);
  } catch {
    return stripBom(utf8); // 环境没有 gbk 解码器:保留 UTF-8 结果,不抛错
  }
}

function stripBom(s) {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

// ---------------------------------------------------------------------------
// 轨道事件解析
// ---------------------------------------------------------------------------

/**
 * 把一个 MTrk 的 body 解析成原始事件流。
 * 支持 running status(第二个及其后的同状态事件省略状态字节)。
 */
function parseTrackEvents(body, trackIndex) {
  const events = [];
  let pos = 0;
  let tick = 0;
  let runningStatus = 0;
  let isDrum = false;
  const label = `轨 #${trackIndex + 1}`;

  while (pos < body.length) {
    const delta = readVarInt(body, pos, body.length, `${label}的 delta-time`);
    pos = delta.pos;
    tick += delta.value;
    if (pos >= body.length) break; // 结尾只有一个孤立的 delta-time:容忍

    let status = body[pos];
    if (status & 0x80) {
      pos++;
      // running status 只对通道消息有意义;遇到 meta/sysex 保留上一次的通道状态
      // (部分导出器在 meta 之后继续省略状态字节,这样更宽容)
      if (status < 0xf0) runningStatus = status;
    } else {
      if (!runningStatus) {
        throw new Error(`MIDI 数据损坏:${label}第 ${pos} 字节处出现数据字节 0x${status.toString(16)},但此前没有可用的 running status`);
      }
      status = runningStatus;
    }

    if (status === 0xff) {
      if (pos >= body.length) throw new Error(`MIDI 数据不完整:${label}的 meta 事件缺少类型字节`);
      const metaType = body[pos++];
      const len = readVarInt(body, pos, body.length, `${label}的 meta 事件长度`);
      pos = len.pos;
      if (pos + len.value > body.length) {
        throw new Error(`MIDI 数据不完整:${label}的 meta 0x${metaType.toString(16).padStart(2, '0')} 声明长度 ${len.value},超出轨块末尾`);
      }
      const data = body.subarray(pos, pos + len.value);
      pos += len.value;
      events.push({ tick, kind: 'meta', metaType, data });
      continue;
    }

    if (status === 0xf0 || status === 0xf7) {
      const len = readVarInt(body, pos, body.length, `${label}的 sysex 长度`);
      pos = len.pos;
      if (pos + len.value > body.length) {
        throw new Error(`MIDI 数据不完整:${label}的 sysex 声明长度 ${len.value},超出轨块末尾`);
      }
      pos += len.value;
      events.push({ tick, kind: 'sysex' });
      continue;
    }

    if (status >= 0xf1) {
      // 0xF1..0xFE 是系统公共/实时消息,SMF 里不应出现(且长度不一,无法安全跳过)
      throw new Error(`MIDI 数据损坏:${label}第 ${pos - 1} 字节出现不支持的状态字节 0x${status.toString(16)},标准 MIDI 文件里不应出现系统实时消息`);
    }

    const hi = status & 0xf0;
    if (pos >= body.length) throw new Error(`MIDI 数据不完整:${label}的通道消息缺少数据字节`);
    const d1 = body[pos++];
    let d2 = null;
    if (hi !== 0xc0 && hi !== 0xd0) {
      if (pos >= body.length) throw new Error(`MIDI 数据不完整:${label}的通道消息缺少第 2 个数据字节`);
      d2 = body[pos++];
    }
    if (hi === 0x90 && d2 > 0 && (status & 0x0f) === 9) isDrum = true;
    events.push({ tick, kind: 'channel', status, hi, d1, d2, channel: status & 0x0f });
  }

  return { events, lastTick: tick, isDrum };
}

// ---------------------------------------------------------------------------
// 时间换算:tempo map 分段积分
// ---------------------------------------------------------------------------

function safeTempos(midi) {
  const list = Array.isArray(midi?.tempos) ? midi.tempos : [];
  return list
    .filter((t) => t && Number.isFinite(t.tick) && Number.isFinite(t.usPerQuarter) && t.usPerQuarter > 0)
    .map((t) => ({ tick: Math.max(0, t.tick), usPerQuarter: t.usPerQuarter }))
    .sort((a, b) => a.tick - b.tick);
}

function assertMidi(midi, fnName) {
  if (!midi || typeof midi !== 'object') {
    throw new Error(`${fnName} 需要一个 MidiData 对象(先用 parseMidi 解析 MIDI)`);
  }
  if (midi.smpte) return midi;
  if (!Number.isFinite(midi.ppq) || midi.ppq <= 0) {
    throw new Error(`${fnName}:MidiData.ppq 无效(${String(midi.ppq)}),无法换算时间`);
  }
  return midi;
}

/** SMPTE 时间码:每帧 tick 数固定,与 tempo 无关 */
function smpteMsPerTick(division) {
  const fps = 256 - ((division >> 8) & 0xff); // 高位是负的 fps 的补码
  const ticksPerFrame = division & 0xff;
  if (fps <= 0 || ticksPerFrame <= 0) return 0;
  return 1000 / (fps * ticksPerFrame);
}

/**
 * tick -> 毫秒。**按 tempo map 分段积分**,不是单一 BPM 线性换算。
 * 返回四舍五入后的整数毫秒(数据模型全程整数毫秒)。
 *
 * 例:480ppq,tick0 = 500000us(120BPM),tick480 = 250000us(240BPM)
 *   tick 480 → 500ms,tick 960 → 750ms(线性算法会得到 1000/1500)
 */
export function tickToMs(midi, tick) {
  assertMidi(midi, 'tickToMs');
  const target = Number.isFinite(tick) ? Math.max(0, tick) : 0;
  if (midi.smpte) return Math.max(0, Math.round(target * smpteMsPerTick(midi.division)));

  const ppq = midi.ppq;
  let curTick = 0;
  let curMs = 0;
  let curUs = DEFAULT_US_PER_QUARTER;

  for (const tempo of safeTempos(midi)) {
    if (tempo.tick >= target) break;
    if (tempo.tick > curTick) {
      curMs += ((tempo.tick - curTick) * curUs) / 1000 / ppq;
      curTick = tempo.tick;
    }
    curUs = tempo.usPerQuarter; // 同一 tick 上有多个 tempo:后一个生效
  }
  curMs += ((target - curTick) * curUs) / 1000 / ppq;
  return Math.max(0, Math.round(curMs));
}

/**
 * 毫秒 -> tick(tickToMs 的反向积分),用于"吸附回原始 MIDI 网格"。
 * 返回非负整数 tick。
 *
 * 注意:tickToMs 按数据模型要求取整到整数毫秒,这个映射是**有损**的 ——
 * 当 1 tick < 1ms(如 66BPM/960ppq ≈ 0.947ms/tick)时,相邻 tick 会落到同一个毫秒上,
 * 反向换算可能有 ±1 tick 的误差。要精确的原始位置请直接用解析结果里的 `tick` 字段
 * (Segment.source.tick / words[].tick 都保留了原始 tick)。
 */
export function msToTick(midi, ms) {
  assertMidi(midi, 'msToTick');
  const target = Number.isFinite(ms) ? ms : 0;
  if (target <= 0) return 0;
  if (midi.smpte) {
    const perTick = smpteMsPerTick(midi.division);
    if (perTick <= 0) return 0;
    return Math.max(0, Math.round(target / perTick));
  }

  const ppq = midi.ppq;
  let curTick = 0;
  let curMs = 0;
  let curUs = DEFAULT_US_PER_QUARTER;

  for (const tempo of safeTempos(midi)) {
    if (tempo.tick <= curTick) {
      curUs = tempo.usPerQuarter;
      continue;
    }
    const msAtTempoTick = curMs + ((tempo.tick - curTick) * curUs) / 1000 / ppq;
    if (msAtTempoTick > target) {
      // 目标落在本段内
      break;
    }
    curMs = msAtTempoTick;
    curTick = tempo.tick;
    curUs = tempo.usPerQuarter;
  }

  const msPerTick = curUs / 1000 / ppq;
  if (msPerTick <= 0) return curTick;
  return Math.max(0, Math.round(curTick + (target - curMs) / msPerTick));
}

// ---------------------------------------------------------------------------
// 主解析
// ---------------------------------------------------------------------------

/**
 * 解析 SMF 字节流。
 * @returns {{format:number, ppq:number|null, smpte:boolean, division:number, trackCount:number,
 *            tempos:Array<{tick:number,usPerQuarter:number}>, tracks:Array<object>}}
 * @throws {Error} 带可读中文原因
 */
export function parseMidi(input) {
  const bytes = toBytes(input);
  if (bytes.length < 14) {
    throw new Error(`不是 MIDI 文件:长度只有 ${bytes.length} 字节,不足以容纳 MThd 头`);
  }
  const headTag = readTag(bytes, 0);
  if (headTag !== 'MThd') {
    throw new Error(`不是 MIDI 文件:文件头标识是 "${headTag}",应为 "MThd"`);
  }
  const headerLen = readU32(bytes, 4);
  if (headerLen < 6) {
    throw new Error(`MIDI 文件损坏:MThd 头长度声明为 ${headerLen},至少应为 6`);
  }
  if (8 + headerLen > bytes.length) {
    throw new Error('MIDI 文件损坏:MThd 头长度超出文件末尾');
  }
  const format = readU16(bytes, 8);
  if (format > 2) {
    throw new Error(`不支持的 MIDI 格式:format = ${format}(只支持 0/1/2)`);
  }
  const declaredTrackCount = readU16(bytes, 10);
  const division = readU16(bytes, 12);
  const smpte = (division & 0x8000) !== 0;
  const ppq = smpte ? null : division;
  if (!smpte && ppq === 0) {
    throw new Error('MIDI 文件损坏:division 为 0(每四分音符 tick 数不能为 0)');
  }

  const rawTracks = [];
  let pos = 8 + headerLen;
  while (pos + 8 <= bytes.length) {
    const id = readTag(bytes, pos);
    const len = readU32(bytes, pos + 4);
    const bodyStart = pos + 8;
    if (bodyStart + len > bytes.length) {
      if (id === 'MTrk') {
        throw new Error(`MIDI 文件损坏:轨块 #${rawTracks.length + 1} 声明长度 ${len},超出文件末尾`);
      }
      break; // 未知块且长度越界:忽略尾部
    }
    const body = bytes.subarray(bodyStart, bodyStart + len);
    pos = bodyStart + len;
    if (id !== 'MTrk') continue;
    rawTracks.push(parseTrackEvents(body, rawTracks.length));
  }
  if (rawTracks.length === 0) {
    throw new Error('不是 MIDI 文件:没有找到任何 MTrk 轨块');
  }

  // tempo 事件是全局的(format 1 通常在轨 1,也允许散落各轨)
  const tempos = [];
  for (const raw of rawTracks) {
    for (const ev of raw.events) {
      if (ev.kind !== 'meta' || ev.metaType !== META_TEMPO || ev.data.length < 3) continue;
      const usPerQuarter = (ev.data[0] << 16) | (ev.data[1] << 8) | ev.data[2];
      if (usPerQuarter > 0) tempos.push({ tick: ev.tick, usPerQuarter });
    }
  }
  tempos.sort((a, b) => a.tick - b.tick); // 稳定排序:同一 tick 上文件里靠后的生效

  const midi = {
    format,
    ppq,
    smpte,
    division,
    trackCount: declaredTrackCount || rawTracks.length,
    tempos,
    tracks: [],
  };
  midi.tracks = rawTracks.map((raw, index) => buildTrack(midi, raw, index));
  return midi;
}

/**
 * 把一个轨的原始事件整理成 MidiTrack:
 * notes / lyrics / texts / markers,并按「歌词来源判定」决定 lyrics 取 0x05 还是 0x01 兜底。
 */
function buildTrack(midi, raw, index) {
  const trackIndex = index;
  const at = (tick, text) => ({ tick, ms: tickToMs(midi, tick), text, trackIndex });

  const lyrics05 = [];
  const texts01 = [];
  const texts = [];
  const markers = [];
  const notes = [];
  const pending = new Map(); // channel*128+note -> [{tick, velocity}]
  let name = null;

  for (const ev of raw.events) {
    if (ev.kind === 'meta') {
      const text = decodeText(ev.data);
      const isAigc = AIGC_JSON_RE.test(text);
      switch (ev.metaType) {
        case META_TRACK_NAME:
          name = text;
          break;
        case META_LYRIC:
          // 规则 4:AIGC 合规 JSON 一律排除(0x05 里同样防御性过滤)
          if (!isAigc) lyrics05.push(at(ev.tick, text));
          break;
        case META_TEXT:
          // 规则 4:AIGC 不进 texts
          if (isAigc) break;
          texts01.push(at(ev.tick, text));
          texts.push({ tick: ev.tick, ms: tickToMs(midi, ev.tick), text, metaType: META_TEXT });
          break;
        case META_MARKER:
          if (isAigc) break;
          texts.push({ tick: ev.tick, ms: tickToMs(midi, ev.tick), text, metaType: META_MARKER });
          markers.push({ tick: ev.tick, ms: tickToMs(midi, ev.tick), text });
          break;
        case META_CUE:
          if (isAigc) break;
          texts.push({ tick: ev.tick, ms: tickToMs(midi, ev.tick), text, metaType: META_CUE });
          break;
        default:
          // 0x02 版权 / 0x03 轨名 / 0x04 乐器名:规则 3,永不作为歌词,也不进 texts
          break;
      }
      continue;
    }

    if (ev.kind !== 'channel') continue;

    const hi = ev.hi;
    if (hi === 0x90 && ev.d2 > 0) {
      const key = ev.channel * 128 + ev.d1;
      const stack = pending.get(key);
      const entry = { tick: ev.tick, velocity: ev.d2 };
      if (stack) stack.push(entry);
      else pending.set(key, [entry]);
      continue;
    }
    if (hi === 0x80 || (hi === 0x90 && ev.d2 === 0)) {
      const key = ev.channel * 128 + ev.d1;
      const stack = pending.get(key);
      const started = stack && stack.length ? stack.shift() : null;
      if (!started) continue; // 没有对应 note-on 的 note-off:忽略,不造零长音符
      const startTick = started.tick;
      const velocity = started.velocity;
      const ms = tickToMs(midi, startTick);
      notes.push({
        tick: startTick,
        ms,
        durationMs: Math.max(0, tickToMs(midi, ev.tick) - ms),
        note: ev.d1,
        velocity,
        channel: ev.channel,
      });
    }
  }

  // 没有配对的 note-on:以轨末收尾,避免丢音(音频未实现,这里只保证数据结构完整)
  for (const [key, stack] of pending) {
    for (const started of stack) {
      const ms = tickToMs(midi, started.tick);
      notes.push({
        tick: started.tick,
        ms,
        durationMs: Math.max(0, tickToMs(midi, raw.lastTick) - ms),
        note: key % 128,
        velocity: started.velocity,
        channel: Math.floor(key / 128),
      });
    }
  }

  notes.sort((a, b) => a.tick - b.tick || a.channel - b.channel || a.note - b.note);

  // ——「歌词来源判定」(逐轨) ——
  // 1. 有 0x05 → lyrics 取 0x05 全集,0x01 只进 texts
  // 2. 没有 0x05 但有非 AIGC 的 0x01 → lyrics 取这些 0x01,lyricSource = "0x01-fallback"
  // 3. 0x02/0x03/0x04/0x06 永不作为歌词
  // 注意:兜底时 0x01 同时保留在 texts 里(texts 是文本事件的结构化日志,见 INTERFACE.md 第 2 节)
  const lyricSource = lyrics05.length > 0 ? '0x05' : texts01.length > 0 ? '0x01-fallback' : null;
  const lyrics = (lyrics05.length > 0 ? lyrics05 : texts01).slice().sort((a, b) => a.tick - b.tick);

  return {
    index: trackIndex,
    name: typeof name === 'string' && name.trim() !== '' ? name : `Track ${trackIndex + 1}`,
    isDrum: raw.isDrum,
    notes,
    lyrics,
    lyricSource,
    texts,
    markers,
  };
}

/**
 * 读文件并解析(薄封装)。只在 Node 里可用,浏览器请先读 File 拿到字节再调 parseMidi。
 * 用 process.getBuiltinModule 惰性取 fs,避免静态 import 'node:fs' 把浏览器端模块图带崩。
 */
export function parseMidiFile(filePath) {
  const proc = globalThis.process;
  if (!proc || typeof proc.getBuiltinModule !== 'function') {
    throw new Error('parseMidiFile 只在 Node 环境可用(需要 process.getBuiltinModule);浏览器请用 parseMidi(buf)');
  }
  const fs = proc.getBuiltinModule('node:fs');
  if (!fs || typeof fs.readFileSync !== 'function') {
    throw new Error('parseMidiFile 无法取得 node:fs');
  }
  if (typeof filePath !== 'string' || filePath === '') {
    throw new Error('parseMidiFile 需要一个文件路径字符串');
  }
  return parseMidi(fs.readFileSync(filePath));
}
