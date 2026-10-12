# 接口契约

本文件记录各模块之间的冻结接口与数据模型。改动这里的签名前,先确认所有调用方都跟上了。
零依赖:不 import 任何 npm 包,只用 Node 内置模块(`node:fs` `node:path` `node:http` …)和浏览器原生 API。

---

## 1. 数据模型

### Segment(时间轴上的一个片段 = 一条字幕)
```js
{
  id: "s_3",                    // 唯一,startsWith("s_") 后接序号(拆分/合并要维护唯一性)
  startMs: 20786,               // 整数毫秒,>= 0
  endMs: 21286,                 // 整数毫秒,必须 > startMs
  text: "慵",                   // 显示的歌词文本
  kind: "lyric",                // "lyric"(子字幕,会被导出) | "meta"(仅参考,默认不导出)
  source: { trackIndex: 1, tick: 6984 },   // 可空。来自 MIDI 的原始位置(用于"吸附到原始时间")
  words: null                   // 可空。逐字时间 [{ text, startMs, endMs }],供增强 LRC / ASS 用
}
```
**约定**:`endMs > startMs` 恒成立。任何产生 `endMs <= startMs` 的操作都要先补齐(默认 `endMs = startMs + 200`)再写模型。

### Track(一条泳道)
```js
{
  id: "t_1",
  name: "Vocal",                // MIDI 轨名,没有就叫 "Track 1"
  visible: true,                // false 则该轨不显示也不导出
  locked: false,                // true 则拒绝一切修改
  segments: [ /* Segment[] , 按 startMs 升序,不重叠 */ ]
}
```

### Project(项目)
```js
{
  id: "p_1758000000000_a1b2c3", // 服务端生成,客户端新建时可为 null
  name: "拣爱",
  createdAt: 1758000000000,     // epoch ms
  updatedAt: 1758000000000,
  durationMs: 60000,            // 时间轴总长,决定标尺刻度;未导入时为 0
  midi: {                       // 可空
    fileName: "《拣爱》游戏同名主题曲.mid",
    ppq: 192,
    format: 1,
    tempoCount: 3,              // tempo 变化数,UI 上要提示"已按 tempo map 换算"
    importedAt: 1758000000000
  },
  tracks: [ /* Track[] */ ],
  settings: {
    gapMs: 600,                 // 重算断句时的间隔阈值
    breakChars: "。!?…—、,.！？",  // 断句用的标点
    minDurationMs: 200          // 片段最短时长
  },
  revision: 12                  // 每次成功保存 +1。服务端持有,客户端只读
}
```

---

## 2. 模块 A —— 核心算法

全部在 `lib/`,**纯函数、不碰 DOM、不碰网络、不碰文件系统(只有 parseMidiFile 读文件)**。

### `lib/midi.mjs`
```js
/** @returns {MidiData} @throws {Error} 带可读中文原因 */
export function parseMidi(buf: Uint8Array): MidiData
export function parseMidiFile(filePath: string): MidiData   // 薄封装:readFileSync + parseMidi

/** tick -> 毫秒。必须按 tempo map 分段积分,不许用单一 BPM 线性算。 */
export function tickToMs(midi: MidiData, tick: number): number
export function msToTick(midi: MidiData, ms: number): number   // 反向,用于吸附回原始网格

/** 解析出的原始结构 */
// MidiData = {
//   format: 1, ppq: 192, smpte: false, division: 192, trackCount: 2,
//   tempos: [{ tick, usPerQuarter }],        // 按 tick 升序,首项通常在 tick 0
//   tracks: [ MidiTrack ]
// }
// MidiTrack = {
//   index: 1, name: "Vocal", isDrum: false,
//   notes: [{ tick, ms, durationMs, note, velocity, channel }],
//   lyrics: [{ tick, ms, text, trackIndex }],   // 见下方「歌词来源判定」
//   lyricSource: "0x05" | "0x01-fallback" | null,
//   texts: [{ tick, ms, text, metaType }],      // 0x01/0x06 等,已过滤 AIGC 合规 JSON
//   markers: [{ tick, ms, text }]
// }
```

#### 歌词来源判定

**歌词不一定在 meta `0x05` 里。** 有的工具把歌词写成 `0x01` text 事件,所以规则必须是**逐轨判定**:

1. 该轨有 `0x05` → `lyrics` 取 `0x05` 全集,`0x01` 只进 `texts`。
2. 该轨**没有** `0x05`,但有不含 AIGC 标记的 `0x01` 文本 → `lyrics` 取这些 `0x01`,`lyricSource = "0x01-fallback"`。
3. `0x03` 轨名 / `0x02` 版权 / `0x04` 乐器名 / `0x06` marker **永不**作为歌词。
4. AIGC 合规 JSON 一律排除。

**为什么不能简化**:把 `0x01` 一律当歌词会误收 AIGC 与版权文本;把 `0x01` 一律丢掉会让那些把歌词放在 `0x01` 的文件变成"没有歌词"。逐轨 fallback 是唯一同时正确的解。

#### 解析必须满足的行为

1. **tempo map 分段积分。** `FF 51` 速度事件可能有多个,`tick → ms` 必须按 tempo 分段累加,不许用单一 BPM 线性换算 —— 一旦有变速就会越走越偏。
2. **文本编码兜底。** 先按 UTF-8 解,出现替换字符 `\uFFFD` 时改用 `TextDecoder('gbk')`。中文 MIDI 常见 GBK。
3. **AIGC 合规 JSON 必须过滤。** AI 生成工具会在 `FF 01` 里塞一段 `{"AIGC":{"Label":"1",…}}`,长得像歌词但不是。正则:`/^\s*\{\s*"AIGC"/`。它不能进 `lyrics`,也不该被当成歌词文本。
4. **没有歌词的文件不许抛错。** 纯乐器 MIDI 是很正常的情况,所有轨 `lyrics.length === 0` 即可。
5. **变长整数最多 5 字节;running status 必须支持**(第二个及其后的同状态事件省略状态字节)。
6. **`tickToMs` 返回整数毫秒**(误差 ≤0.5ms)。需要精确原始位置时用 `source.tick` 回算,不要拿整数字段反推 —— `msToTick` 在 1 tick < 1ms 的文件上最多会差 ±1 tick。

#### 数值字段一律用 `Number.isFinite()` 判空

**第一个歌词很可能就在 tick 0(即 `startMs === 0`)。** 任何把 `0` 当作"无值/未设置"的判空写法(例如 `if (!seg.startMs)`)都会把它当空值丢掉。全项目禁止用真值判断数值字段。

### `lib/segments.mjs`
```js
/**
 * 音节 -> 句子。规则:
 *  1. 相邻音节间隔 > settings.gapMs 则断开
 *  2. 上一个音节的文本以 settings.breakChars 中的字符结尾则断开
 *  3. 每段时长不足 settings.minDurationMs 时向外补齐(但不与邻段重叠)
 * 段内保留逐字时间到 words,便于增强 LRC / ASS。
 */
export function buildSegments(lyricEvents, settings): Segment[]
/** 用当前 settings 重新断句,但保留用户手改过的段(claimed 的段原样保留,原地合并回结果) */
export function regroupSegments(segments, settings): Segment[]
/** 按时间拆分一条,返回 [left, right] */
export function splitSegment(seg, atMs): [Segment, Segment]
/** 合并相邻两条(必须同轨、时间相邻) */
export function mergeSegments(a, b): Segment
/** 整体平移(offsetMs 可为负,结果会被 clamp 到 >= 0) */
export function shiftSegments(segments, offsetMs): Segment[]
/** 保证升序、不重叠、endMs > startMs */
export function normalizeSegments(segments): Segment[]
```

### `lib/exporters.mjs`
```js
export function toSRT(tracks, opts?): string
export function toVTT(tracks, opts?): string
export function toLRC(tracks, opts?): string          // 行级 [mm:ss.xx]
export function toEnhancedLRC(tracks, opts?): string  // 逐字 <mm:ss.xx>,行尾也带 <mm:ss.xx>
export function toASS(tracks, opts?): string          // 含 \k 卡拉OK 标签
export const EXPORTERS  // { srt: { ext:'.srt', mime, label:'SRT 字幕', fn: toSRT }, ... }
// opts = { includeHidden?: boolean /*默认 false*/, includeMeta?: boolean /*默认 false*/, title?: string }
```

**格式硬要求**:
- **SRT**:`1\n00:00:20,786 --> 00:00:21,286\n慵\n\n`。毫秒逗号、序号从 1 开始、块间空行、UTF-8(不加 BOM)、`\r\n` 不出现。
- **VTT**:首行 `WEBVTT`,时间用 `.` 小数(`00:00:20.786 --> 00:00:21.286`)。
- **LRC**:`[00:20.78]慵`(两位小数=厘秒)。多轨时按时间合并排序。
- **增强 LRC**:`[00:20.78]<00:20.78>慵<00:21.28>懒`,行尾补一个结束标记。**没有 words 的段要退化成行首单个标记,不许输出空 `<>`**。
- **ASS**:
  ```
  [Script Info]
  ScriptType: v4.00+
  PlayResX: 1920
  PlayResY: 1080
  [V4+ Styles]
  Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
  Style: Default,Arial,64,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,2,0,2,40,40,60,1
  [Events]
  Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
  Dialogue: 0,0:00:20.79,0:00:21.29,Default,,0,0,0,,{\k50}慵
  ```
  ASS 时间 `h:mm:ss.cc`(**小时不补零**,厘秒)。`\k` 单位是**厘秒**(centisecond),必须 `Math.round(ms/10)`。
  上面这个例子里 20786→21286 是 500ms,所以是 `\k50`。
  **`\k` 之和必须等于「显示结束 − 显示开始」**:逐字时前 n-1 个字取 `floor(时长/10)`,最后一个吃余数,
  这样总和恒等于 `Math.round((end-start)/10)`,不会出现行末差 1 厘秒的漂移。
- 所有导出器:**忽略 `visible === false` 的轨**、默认忽略 `kind === "meta"` 的段。
- 时间格式化必须处理 > 1 小时。

### `lib/project.mjs`
```js
export function createProject({ name, midiData, fileName, settings }): Project   // 从 MidiData 建项目
export function emptyProject(name?): Project
export function normalizeProject(p: any): Project    // 版本迁移 + 字段补全,脏数据不许抛错
export function projectToSegments(p: Project): Segment[]  // 拍平(含 trackId)
export function recomputeDuration(p: Project): number
export const PROJECT_VERSION = 1
```

---

## 3. 模块 B —— 时间轴编辑器

产出 `public/js/state.js`、`public/js/render_timeline.js`、`public/js/interact.js`。
**只依赖 DOM / Canvas 和模块 C 的 `store`**;不许直接 fetch。

### `public/js/state.js`
```js
export function createAppState(store)   // store 见第 4 节
// AppState = {
//   project,                 // Project|null
//   selection: { trackId, segmentIds: [] },
//   view: { pxPerMs, scrollMs, laneHeight, playheadMs },
//   dirty: false,
//
//   // —— 所有修改都必须走这批方法(它们负责:改模型 + 标脏 + 通知)。返回 void。
//   //     禁止外部直接改 project.tracks[i].segments[j].startMs。
//   setSegments(trackId, segments),
//   updateSegment(trackId, segmentId, patch),      // patch: {startMs?, endMs?, text?, kind?}
//   addSegment(trackId, segment),
//   removeSegments(trackId, segmentIds),
//   splitSegmentAt(trackId, segmentId, atMs),
//   mergeWithNext(trackId, segmentId),
//   shiftTrack(trackId, offsetMs),
//   shiftAll(offsetMs),
//   regroup(settingsPatch),                        // 改 settings 后重算断句
//   setTrackFlag(trackId, flag, value),            // flag: 'visible'|'locked'
//   setTrackName(trackId, name),
//   select(trackId, segmentIds, mode),             // mode: 'replace'|'add'|'toggle'
//   setView(patch),
//
//   undo(), redo(), canUndo(), canRedo(),
//   subscribe(fn),        // fn(state) 任意变化后调用,返回退订函数
//   isDirty(), markClean(revision)
// }
```
**关键**:撤销/重做用**快照栈**(对 tracks 深拷贝),容量 100。所有 mutator 在改动前 push 快照。撤销/重做本身也要标脏(它们也是改动)。

### `public/js/render_timeline.js`
```js
export function createTimeline(canvas, state)  // 返回 { render(), hitTest(x, y), resize(), destroy() }
// 职责:纯绘制 + 命中测试。不改模型、不绑事件。
// 画:左侧轨道名列已由 DOM 负责,canvas 只画时间轴区域 —— 背景网格、标尺刻度、
//     每轨一条泳道、片段圆角矩形 + 文本(按宽度截断)、选中高亮、拖拽预览、吸附参考线、播放头。
// hitTest(x,y) -> { trackId, segmentId, zone: 'body'|'left'|'right' } | null
// DPR 缩放必须处理(devicePixelRatio),否则高分屏发虚。
```

### `public/js/interact.js`
```js
export function attachInteractions(el, state, timeline)
// 绑定:点击选中、Shift/Ctrl 多选、空白处框选、
//       拖 body 平移时间、拖左右边改时长、滚轮平移、Ctrl+滚轮缩放(以鼠标为锚点)、
//       拖拽时实时预览、松开才提交到 state(一次拖动 = 一条撤销记录,不许产生几十条)。
// 吸附:吸附到其它片段边界、播放头、整秒、以及 segment.source 的原始 MIDI 时间(±6px 内)。
// 键盘:Delete/Backspace 删除、Ctrl+Z/Y 撤销重做、Ctrl+A 全选、
//       ←/→ 移动 10ms(Shift 100ms)、[ ] 设起止、空格(无音频,忽略)、+/− 缩放、Home/End。
// 文本就地编辑:双击片段进入编辑,Enter 提交、Esc 取消。
```

---

## 4. 模块 C —— 外壳 / 持久化 / 导入导出

产出 `public/index.html`、`public/css/`、`public/js/ui.js`、`public/js/store.js`、`public/js/api.js`、`public/js/exporter.js`、`public/js/importers.js`。

### `public/js/store.js` —— 持久化适配器(**静态部署的关键**)
```js
/** 两种实现,运行时二选一 */
export function createServerStore(baseUrl = '')  // REST,见第 5 节
export function createLocalStore()               // localStorage,纯静态部署用
/** 探测:能 GET /api/health 通就用 server,否则 local。必须 try/catch,不许抛出去。 */
export async function detectStore(): Promise<Store>

// Store 接口(两种实现必须完全一致):
// {
//   kind: 'server' | 'local',
//   async listProjects(): [{ id, name, updatedAt, revision }],
//   async createProject(project): Project,          // 返回带 id/revision 的
//   async loadProject(id): Project,
//   async saveProject(project): Project,            // 返回带新 revision 的
//   async getHistory(id): [{ revision, savedAt, bytes }],
//   async restoreRevision(id, revision): Project,
//   async renameProject(id, name): Project,
//   async deleteProject(id): void
// }
```

### `public/js/api.js`
```js
export function createSync(state, store, { debounceMs = 300, onStatus } = {})
// 返回 { flush(), start(), stop(), status() }
// 职责:订阅 state,脏了就 debounceMs 后 saveProject;
//   flush() 立即保存;
//   visibilitychange(hidden) / pagehide 时同步 flush;
//   beforeunload 时若仍脏则 e.preventDefault();
//   onStatus({ state:'saved'|'saving'|'dirty'|'error'|'offline', revision, at }); 
//   保存失败:标记 error、降级写 localStorage 备份、每 3s 重试,不许静默丢。
```

### `public/index.html` + `public/css/`
布局:顶部工具栏(新建 / 打开 / 导入 MIDI / 项目名 / 撤销重做 / 导出 ▾ / 保存状态指示灯)、
左侧轨道面板(每轨:名字可改、可见、锁定、片段数)、中间时间轴 canvas、右侧属性面板(选中片段:起止时间
可直接输入 ms 或 `mm:ss.mmm`、文本、拆分/合并按钮、批量偏移)、底部状态栏(缩放、总长、选中数)。

### `public/js/importers.js` / `public/js/exporter.js`
```js
// importers.js
export async function readMidiFile(file: File): Promise<{ buf: Uint8Array, name: string }>
export function midiToProject(buf, fileName, settings?): Project   // 调 lib/midi + lib/segments + lib/project
// exporter.js
export function buildExport(format: string, project, opts?): { text: string, filename: string }
export function download(text, filename, mime)  // Blob + a[download]
export function exportFormats(): [{ id, label, ext }]   // 从 lib/exporters.mjs 的 EXPORTERS 生成
```

---

## 5. 服务端 REST

单端口,同时伺服静态文件与 API。默认 **4517**,可用 `DSH_SUB_PORT` 覆盖。
`server/data/` 下每个项目一个 JSON;`server/data/.history/<id>/<revision>.json` 存快照(保留最近 30)。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | `{ ok:true, kind:'server', version }` |
| GET | `/api/projects` | 项目列表 |
| POST | `/api/projects` | 收 Project,分配 id,落盘,返回带 `revision:1` |
| GET | `/api/projects/:id` | 返回完整 Project |
| PUT | `/api/projects/:id` | 收 `{ project }`,落盘,**revision+1**,返回 `{ id, revision, updatedAt }` |
| GET | `/api/projects/:id/history` | 快照列表 |
| POST | `/api/projects/:id/restore` | `{ revision }` → 用快照覆盖并 +1 |
| PATCH | `/api/projects/:id` | `{ name }` 重命名 |
| DELETE | `/api/projects/:id` | 删除 |
| GET | `/api/projects/:id/export/:format` | 服务端直接导出文本 |

**落盘必须原子**:写 `xxx.json.tmp` → `fsync` → `rename` 覆盖。禁止直接 `writeFile` 覆盖正式文件。
**并发保护**:同一项目同时 PUT 要串行化(每项目一条 Promise 队列),不许交错写坏。
**校验**:PUT 的 body 用 `normalizeProject` 过一遍;`revision` 不匹配时返回 `409` + 当前 revision(客户端据此重新拉取)。

#### revision 语义

**`revision` 唯一标识一份内容状态。任何会改变项目内容或元数据的操作都必须 +1,包括重命名(`PATCH`)。**

理由:快照文件名是 `<revision>.json`。如果重命名不 +1,那么"改内容"和"只改名字"两次操作会产生同一个 revision,后写的快照会**覆盖掉前一份**,而那份快照里的名字是旧的 —— 用户回滚时会看到一个从未存在过的组合。`revision` 一旦不唯一,快照和 409 冲突检测同时失效。

推论:
- `PUT`(保存内容)→ +1
- `PATCH`(重命名)→ **+1**(服务端与 `createLocalStore` 必须一致)
- `POST /restore`(用快照覆盖)→ +1
- `GET` → 不变

`createLocalStore` 里**不存在**"服务端权威"这个约束,但它**不允许**在语义上与 `createServerStore` 分叉:两个适配器对同一串操作必须产生同样的 revision 序列,否则同一份代码在两种部署下的 409 行为会不一样。


---

## 6. 静态部署

`scripts/build-static.mjs` 把 `public/` 与 `lib/` 合成一个**可以直接当站点根**的 `dist/static/`:

- `public/` 的**内容**铺到 `dist/static/` 根上(`index.html`、`js/`、`css/`),`lib/` 作为它的兄弟目录
- 因为扁平布局下 `js/` 与 `lib/` 是兄弟,构建时把 `public/js/*.js` 里的 `../../lib/` 重写成 `../lib/`
- `store.js` 的 `detectStore()` 在静态环境探测不到 `/api/health` 时自动落到 `createLocalStore()`
- 源文件不全时**中止构建**,而不是产出残缺产物

产物落地后自检两道:
1. 逐层解引用所有 JS 的 `import` 与 HTML 的 `src`/`href`(HTML 也要查,否则会漏掉入口页整条依赖链)
2. 除 `store.js` 的探测之外,不得出现绝对 `/api` 硬依赖

另外注意:ES module 在 `file://` 下会被 CORS 拦掉,所以本地预览必须走 HTTP(`scripts/serve-static.mjs`),不能双击 `index.html`。
