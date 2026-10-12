/**
 * lib/exporters.mjs —— 五种字幕导出:SRT / WebVTT / LRC / 增强 LRC / ASS
 *
 * 纯函数:输入 Track[](含 segments),输出字符串。
 * - 忽略 `visible === false` 的轨(除非 opts.includeHidden)
 * - 默认忽略 `kind === "meta"` 的段(除非 opts.includeMeta)
 * - 空文本的段不出字幕(空字幕行没有意义)
 * - 时间格式化一律从**总毫秒**一次算出时分秒,不做 60 进位累加 ——
 *   60000ms 必须输出 `01:00.000`,不能是 `00:60.000`;超过一小时也不补零小时
 *
 * 厘秒(centisecond)的口径:
 * - SRT/VTT:毫秒原样(`,` / `.` 分隔)
 * - LRC/增强 LRC:**截断**到厘秒(`[00:20.78]` 对应 20786ms)
 * - ASS:**四舍五入**到厘秒(`Math.round(ms/10)`;`0:00:20.79` 对应 20786ms)
 *   `\k` 的总和恒等于该行时长的厘秒数:前 n-1 个字取 floor(时长/10),最后一个字吃掉余数。
 */

const NEWLINE_RE = /\r\n|\r|\n/g;

function pad(n, width) {
  return String(n).padStart(width, '0');
}

/** 收集要导出的字幕行,按时间升序(多轨按时间合并排序) */
function collectCues(tracks, opts) {
  const options = opts && typeof opts === 'object' ? opts : {};
  const list = Array.isArray(tracks) ? tracks : [];
  const cues = [];
  list.forEach((track, trackIndex) => {
    if (!track || typeof track !== 'object') return;
    if (track.visible === false && options.includeHidden !== true) return;
    const segments = Array.isArray(track.segments) ? track.segments : [];
    segments.forEach((seg) => {
      if (!seg || typeof seg !== 'object') return;
      if (seg.kind === 'meta' && options.includeMeta !== true) return;
      const text = seg.text === null || seg.text === undefined ? '' : String(seg.text);
      if (text.trim() === '') return;
      const startMs = Math.max(0, Math.round(Number.isFinite(seg.startMs) ? seg.startMs : 0));
      let endMs = Math.round(Number.isFinite(seg.endMs) ? seg.endMs : startMs + 200);
      if (!(endMs > startMs)) endMs = startMs + 200;
      const words = Array.isArray(seg.words)
        ? seg.words
          .filter((w) => w && typeof w === 'object' && Number.isFinite(w.startMs))
          .map((w) => ({
            text: w.text === null || w.text === undefined ? '' : String(w.text),
            startMs: Math.max(0, Math.round(w.startMs)),
            endMs: Math.max(0, Math.round(Number.isFinite(w.endMs) ? w.endMs : w.startMs)),
          }))
          .sort((a, b) => a.startMs - b.startMs)
        : null;
      cues.push({ startMs, endMs, text, words: words && words.length > 0 ? words : null, trackIndex });
    });
  });
  // 稳定排序:同 startMs 时保持 轨顺序/段顺序
  cues.sort((a, b) => a.startMs - b.startMs);
  return cues;
}

/** 单行化:字幕文本里的换行按格式各自处理 */
function oneLine(text) {
  return text.replace(NEWLINE_RE, ' ');
}

// ---------------------------------------------------------------------------
// 时间格式化(全部从总毫秒一次算出,天然处理 > 1 小时 与 跨分钟进位)
// ---------------------------------------------------------------------------

/** HH:MM:SS,mmm / HH:MM:SS.mmm */
function formatHMS(ms, sep) {
  const t = Math.max(0, Math.round(ms));
  const hours = Math.floor(t / 3600000);
  const minutes = Math.floor(t / 60000) % 60;
  const seconds = Math.floor(t / 1000) % 60;
  const millis = t % 1000;
  return `${pad(hours, 2)}:${pad(minutes, 2)}:${pad(seconds, 2)}${sep}${pad(millis, 3)}`;
}

/** LRC 的 [mm:ss.xx]:分钟不取模(> 1 小时就是 60 分以上),厘秒截断 */
function formatLrc(ms) {
  const t = Math.max(0, Math.round(ms));
  const totalCs = Math.floor(t / 10); // 截断:20786ms → 20.78
  const cs = totalCs % 100;
  const seconds = Math.floor(totalCs / 100) % 60;
  const minutes = Math.floor(totalCs / 6000);
  return `${pad(minutes, 2)}:${pad(seconds, 2)}.${pad(cs, 2)}`;
}

/** ASS 的 h:mm:ss.cc:小时不补零。入参是**总厘秒**,避免二次取整 */
function formatAssCs(totalCs) {
  const t = Math.max(0, Math.round(totalCs));
  const cs = t % 100;
  const seconds = Math.floor(t / 100) % 60;
  const minutes = Math.floor(t / 6000) % 60;
  const hours = Math.floor(t / 360000);
  return `${hours}:${pad(minutes, 2)}:${pad(seconds, 2)}.${pad(cs, 2)}`;
}

/** ASS 文本转义:花括号是标签语法,换行用 \N */
function escapeAssText(text) {
  return oneLine(text).replace(/[{}]/g, (c) => `\\${c}`);
}

/**
 * 卡拉OK 标签:无 words 时整行一个 \k;有 words 时逐字。
 * \k 之和恒等于 totalCs(= 行时长 Math.round(ms/10) = 显示结束 - 显示开始),
 * 这样 "解析 Dialogue 时间戳算出的时长" 与 "\k 之和" 永远一致:
 * 前 n-1 个字取 floor(自身时长/10),最后一个字吃掉余数(保证非负且总和精确)。
 */
function assKaraoke(cue, totalCs) {
  if (!cue.words) return `{\\k${totalCs}}${escapeAssText(cue.text)}`;
  let used = 0;
  const parts = cue.words.map((word, i) => {
    const isLast = i === cue.words.length - 1;
    const cs = isLast ? Math.max(0, totalCs - used) : Math.max(0, Math.floor((word.endMs - word.startMs) / 10));
    if (!isLast) used += cs;
    return `{\\k${cs}}${escapeAssText(word.text)}`;
  });
  return parts.join('');
}

// ---------------------------------------------------------------------------
// 导出器
// ---------------------------------------------------------------------------

/** SRT:序号从 1、毫秒用逗号、块间空行、行尾 \n\n、绝不出现 \r\n */
export function toSRT(tracks, opts) {
  const cues = collectCues(tracks, opts);
  if (cues.length === 0) return '';
  const blocks = cues.map((cue, i) => `${i + 1}\n${formatHMS(cue.startMs, ',')} --> ${formatHMS(cue.endMs, ',')}\n${cue.text}`);
  return `${blocks.join('\n\n')}\n\n`;
}

/** WebVTT:首行 WEBVTT,时间用 . 小数 */
export function toVTT(tracks, opts) {
  const cues = collectCues(tracks, opts);
  if (cues.length === 0) return 'WEBVTT\n';
  const blocks = cues.map((cue) => `${formatHMS(cue.startMs, '.')} --> ${formatHMS(cue.endMs, '.')}\n${cue.text}`);
  return `WEBVTT\n\n${blocks.join('\n\n')}\n`;
}

/** LRC:行级 [mm:ss.xx],多轨按时间合并 */
export function toLRC(tracks, opts) {
  const cues = collectCues(tracks, opts);
  if (cues.length === 0) return '';
  const lines = cues.map((cue) => `[${formatLrc(cue.startMs)}]${oneLine(cue.text)}`);
  return `${lines.join('\n')}\n`;
}

/** 增强 LRC:逐字 <mm:ss.xx>,行尾补一个结束标记;没有 words 的段退化成行首单个标记(不输出空 <>) */
export function toEnhancedLRC(tracks, opts) {
  const cues = collectCues(tracks, opts);
  if (cues.length === 0) return '';
  const lines = cues.map((cue) => {
    const head = `[${formatLrc(cue.startMs)}]`;
    const end = `<${formatLrc(cue.endMs)}>`;
    if (!cue.words) return `${head}${oneLine(cue.text)}${end}`;
    const body = cue.words.map((w) => `<${formatLrc(w.startMs)}>${oneLine(w.text)}`).join('');
    return `${head}${body}${end}`;
  });
  return `${lines.join('\n')}\n`;
}

/** ASS:含 \k 卡拉OK 标签 */
export function toASS(tracks, opts) {
  const options = opts && typeof opts === 'object' ? opts : {};
  const cues = collectCues(tracks, opts);
  const lines = [
    '[Script Info]',
    'ScriptType: v4.00+',
  ];
  if (typeof options.title === 'string' && options.title !== '') lines.push(`Title: ${oneLine(options.title)}`);
  lines.push(
    'PlayResX: 1920',
    'PlayResY: 1080',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    'Style: Default,Arial,64,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,2,0,2,40,40,60,1',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  );
  for (const cue of cues) {
    // 显示时间与 \k 用同一套厘秒数:结束时间 = 开始厘秒 + 行时长厘秒,
    // 避免"结束时间各自取整"与"\k 之和"差 1cs(20786→22914 这类端点反向取整)
    const startCs = Math.max(0, Math.round(cue.startMs / 10));
    const totalCs = Math.max(0, Math.round((cue.endMs - cue.startMs) / 10));
    const endCs = startCs + totalCs;
    lines.push(`Dialogue: 0,${formatAssCs(startCs)},${formatAssCs(endCs)},Default,,0,0,0,,${assKaraoke(cue, totalCs)}`);
  }
  return `${lines.join('\n')}\n`;
}

/** 导出格式注册表:public/js/exporter.js 与 server 的 /export/:format 都用它 */
export const EXPORTERS = Object.freeze({
  srt: { id: 'srt', ext: '.srt', mime: 'application/x-subrip', label: 'SRT 字幕', fn: toSRT },
  vtt: { id: 'vtt', ext: '.vtt', mime: 'text/vtt', label: 'WebVTT 字幕', fn: toVTT },
  lrc: { id: 'lrc', ext: '.lrc', mime: 'text/plain;charset=utf-8', label: 'LRC 歌词', fn: toLRC },
  'enhanced-lrc': { id: 'enhanced-lrc', ext: '.lrc', mime: 'text/plain;charset=utf-8', label: '增强 LRC(逐字)', fn: toEnhancedLRC },
  ass: { id: 'ass', ext: '.ass', mime: 'text/x-ssa', label: 'ASS 卡拉OK', fn: toASS },
});
