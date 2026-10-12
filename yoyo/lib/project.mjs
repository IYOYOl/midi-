/**
 * lib/project.mjs —— 项目模型:从 MidiData 建项目 / 空项目 / 脏数据归一化 / 拍平 / 时长
 *
 * 契约见 INTERFACE.md 第 1 节(数据模型)与第 2 节(project.mjs 签名)。
 * 纯函数(createProject 内部会 buildSegments,但不碰 DOM/网络/文件系统)。
 *
 * normalizeProject 是服务端 PUT 与 store 的守门员:**任何脏数据都不许抛错**,
 * 一律补全成合法 Project(第 5 节要求 PUT 的 body 过一遍它)。
 */

import { buildSegments, normalizeSegments, normalizeSettings, DEFAULT_SETTINGS } from './segments.mjs';

/** 项目结构版本,normalizeProject 据此迁移 */
export const PROJECT_VERSION = 1;

/** 段时长非法时的补齐量 */
const FALLBACK_DURATION_MS = 200;

function isObj(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function str(value, fallback) {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  return trimmed === '' ? fallback : trimmed;
}

function num(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

function nonNegInt(value, fallback) {
  const n = num(value, fallback);
  return Math.max(0, Math.round(n));
}

/** 从文件名推项目名(去掉目录与扩展名) */
function nameFromFileName(fileName) {
  if (typeof fileName !== 'string' || fileName.trim() === '') return '未命名项目';
  const base = fileName.replace(/\\/g, '/').split('/').pop() ?? '';
  const withoutExt = base.replace(/\.(mid|midi|smf)$/i, '');
  return withoutExt.trim() === '' ? '未命名项目' : withoutExt.trim();
}

function trackNameOf(midiTrack, index) {
  if (isObj(midiTrack) && typeof midiTrack.name === 'string' && midiTrack.name.trim() !== '') return midiTrack.name;
  return `Track ${index + 1}`;
}

/**
 * 从 MidiData 建项目(导入 MIDI 的主入口)。
 * - 每条 MIDI 轨对应一条 Track(空轨也保留,时间轴上仍是泳道)
 * - 片段由 buildSegments 断句得到,id 为 s_N、轨 id 为 t_N
 * - durationMs 由 recomputeDuration 算出
 */
export function createProject({ name, midiData, fileName, settings } = {}) {
  const now = Date.now();
  const cfg = normalizeSettings(settings);
  const midi = isObj(midiData) ? midiData : null;
  const midiTracks = midi && Array.isArray(midi.tracks) ? midi.tracks : [];

  const lyricEvents = [];
  for (const midiTrack of midiTracks) {
    const lyrics = isObj(midiTrack) && Array.isArray(midiTrack.lyrics) ? midiTrack.lyrics : [];
    for (const lyric of lyrics) lyricEvents.push(lyric);
  }
  const segments = buildSegments(lyricEvents, cfg);

  const byTrackIndex = new Map();
  for (const segment of segments) {
    const trackIndex = num(segment.source?.trackIndex, 0);
    if (!byTrackIndex.has(trackIndex)) byTrackIndex.set(trackIndex, []);
    byTrackIndex.get(trackIndex).push(segment);
  }

  const tracks = midiTracks.map((midiTrack, index) => ({
    id: `t_${index + 1}`,
    name: trackNameOf(midiTrack, index),
    visible: true,
    locked: false,
    segments: byTrackIndex.get(index) ?? [],
  }));

  const project = {
    version: PROJECT_VERSION,
    id: null, // 服务端生成;客户端新建时为 null
    name: str(name, nameFromFileName(fileName)),
    createdAt: now,
    updatedAt: now,
    durationMs: 0,
    midi: midi
      ? {
        fileName: typeof fileName === 'string' && fileName !== '' ? fileName : null,
        ppq: num(midi.ppq, null),
        format: num(midi.format, null),
        tempoCount: Array.isArray(midi.tempos) ? midi.tempos.length : 0,
        importedAt: now,
      }
      : null,
    tracks,
    settings: cfg,
    revision: 0, // 服务端持有,客户端只读
  };
  project.durationMs = recomputeDuration(project);
  return project;
}

/** 空项目(未导入 MIDI:durationMs 0、midi null、没有轨) */
export function emptyProject(name) {
  const now = Date.now();
  return {
    version: PROJECT_VERSION,
    id: null,
    name: str(name, '未命名项目'),
    createdAt: now,
    updatedAt: now,
    durationMs: 0,
    midi: null,
    tracks: [],
    settings: { ...DEFAULT_SETTINGS },
    revision: 0,
  };
}

function normalizeMidiInfo(raw) {
  if (!isObj(raw)) return null;
  return {
    fileName: typeof raw.fileName === 'string' && raw.fileName !== '' ? raw.fileName : null,
    ppq: Number.isFinite(raw.ppq) ? raw.ppq : null,
    format: Number.isFinite(raw.format) ? raw.format : null,
    tempoCount: nonNegInt(raw.tempoCount, 0),
    importedAt: nonNegInt(raw.importedAt, Date.now()),
  };
}

/**
 * 版本迁移 + 字段补全。**任何输入都不抛错**(null / 字符串 / 缺字段 / NaN / 重叠段 / 重复 id …)。
 * 输出一定是合法 Project:轨与段升序不重叠、endMs > startMs、settings 完整、durationMs 不小于内容末端。
 */
export function normalizeProject(input) {
  const src = isObj(input) ? input : {};
  const now = Date.now();

  const out = {
    version: PROJECT_VERSION,
    id: typeof src.id === 'string' && src.id !== '' ? src.id : null,
    name: str(src.name, '未命名项目'),
    createdAt: nonNegInt(src.createdAt, now),
    updatedAt: nonNegInt(src.updatedAt, now),
    durationMs: nonNegInt(src.durationMs, 0),
    midi: normalizeMidiInfo(src.midi),
    tracks: [],
    settings: normalizeSettings(src.settings),
    revision: nonNegInt(src.revision, 0),
  };

  const rawTracks = Array.isArray(src.tracks) ? src.tracks : [];
  const usedTrackIds = new Set();
  rawTracks.forEach((rawTrack, index) => {
    if (!isObj(rawTrack)) return;
    let id = str(rawTrack.id, `t_${index + 1}`);
    while (usedTrackIds.has(id)) id = `${id}_${index + 1}`;
    usedTrackIds.add(id);

    const rawSegments = Array.isArray(rawTrack.segments) ? rawTrack.segments.filter(isObj) : [];
    // 同一条轨的段必须放在同一个分组里做重叠处理,所以先注入 trackId 再归一化
    const hadTrackId = rawSegments.some((s) => typeof s.trackId === 'string');
    const normalized = normalizeSegments(rawSegments.map((s) => ({ ...s, trackId: id })));
    const segments = hadTrackId ? normalized : normalized.map(({ trackId, ...rest }) => rest);

    out.tracks.push({
      id,
      name: str(rawTrack.name, `Track ${index + 1}`),
      visible: rawTrack.visible !== false,
      locked: rawTrack.locked === true,
      segments,
    });
  });

  // durationMs 是"时间轴总长":不能小于实际内容末端(否则标尺会短于内容)
  out.durationMs = Math.max(out.durationMs, recomputeDuration(out));
  return out;
}

/**
 * 项目 → 扁平片段列表(每条带上 trackId),按 startMs 升序。
 * 不按 visible/kind 过滤 —— 那是渲染与导出的职责,拍平只做结构转换。
 */
export function projectToSegments(project) {
  const tracks = isObj(project) && Array.isArray(project.tracks) ? project.tracks : [];
  const out = [];
  for (const track of tracks) {
    if (!isObj(track)) continue;
    const segments = Array.isArray(track.segments) ? track.segments : [];
    for (const segment of segments) {
      if (!isObj(segment)) continue;
      out.push({ ...segment, trackId: track.id });
    }
  }
  out.sort((a, b) => num(a.startMs, 0) - num(b.startMs, 0)); // 稳定排序:同值保持轨/段顺序
  return out;
}

/**
 * 重算时间轴总长 = 所有轨所有片段 endMs 的最大值(未导入时为 0)。
 * 同时写回 project.durationMs 并返回该值,调用方两种用法都成立:
 *   const ms = recomputeDuration(p)   // p.durationMs 已更新
 */
export function recomputeDuration(project) {
  const tracks = isObj(project) && Array.isArray(project.tracks) ? project.tracks : [];
  let max = 0;
  for (const track of tracks) {
    if (!isObj(track)) continue;
    const segments = Array.isArray(track.segments) ? track.segments : [];
    for (const segment of segments) {
      if (!isObj(segment)) continue;
      const end = num(segment.endMs, NaN);
      if (Number.isFinite(end) && end > max) max = end;
      else if (!Number.isFinite(end)) {
        const start = num(segment.startMs, 0);
        if (start + FALLBACK_DURATION_MS > max) max = start + FALLBACK_DURATION_MS;
      }
    }
  }
  max = Math.max(0, Math.round(max));
  if (isObj(project)) project.durationMs = max;
  return max;
}
