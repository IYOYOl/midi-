# MIDI → 字幕

把一个 MIDI 文件里的歌词时间拆出来,在**像剪辑软件一样的多轨道时间轴**上二次编辑,然后导出成字幕文件。

零依赖:没有任何 npm 包,没有构建步骤,没有框架。只用 Node 内置模块和浏览器原生 ESM。

---

## 部署方式(两种,同一套代码)

| | 服务端模式 | 静态模式 |
|---|---|---|
| 怎么跑 | 双击 **`start.bat`** | 双击 **`serve-static.bat`** |
| 或命令行 | `node server/server.mjs` | `node scripts/build-static.mjs` + `node scripts/serve-static.mjs` |
| 地址 | http://127.0.0.1:4517 | 本地预览 4518;线上则是你托管在哪就是哪 |
| 数据存哪 | 服务器磁盘 `server/data/` | 浏览器 localStorage |
| 刷新不清空 | ✅ 服务端是唯一真相 | ✅ localStorage 持久化 |
| 换设备/换浏览器 | ✅ 数据跟着服务器 | ❌ 数据跟着浏览器 |
| 多人访问同一个项目 | ✅ | ❌ |
| 需要 Node | 是 | 是(仅用于构建和本地预览;产出的 `dist/static/` 本身不需要) |

**两个 .bat 都是双击即用**:自动检查 Node、清掉占用端口的旧进程(避免出现"窗口一闪而过"却看不出原因)、起服务、打开浏览器。窗口保持打开就是服务在跑,**关掉窗口即停止**。想换端口就拖一个参数进去,或者命令行 `start.bat 8080`。

> `.bat` 里的提示文字是英文的,这不是偷懒:cmd.exe 按控制台代码页读脚本,UTF-8 的中文在 .bat 里会变乱码,除非把文件另存为 GBK —— 对一个启动器来说不值得引入这种脆弱性。

**核心编辑逻辑是同一份代码**(`lib/` 下全部是浏览器原生 ESM),差异只在持久化适配器:`store.js` 启动时探测 `GET /api/health`,通了用服务端存,1.5 秒内不通就自动落到 localStorage。功能不缩水:项目列表、新建、打开、保存、重命名、删除、历史快照、恢复,两种模式都有。

### 服务端模式

```powershell
start.bat                          # 双击,或命令行(默认 4517)
start.bat 8080                     # 换端口
node server/server.mjs             # 等价
$env:DSH_SUB_PORT=8080; node server/server.mjs
node server/server.mjs --port 0    # 系统分配空闲端口,启动时打印实际端口
```

打开 http://127.0.0.1:4517 ,导入 MIDI 就能用。

`/` 会 302 到 `/public/index.html`。这一步不是多余的:应用页里的资源是相对路径(`js/ui.js`、`css/theme.css`),必须在 `/public/` 这一级才能解析对,否则浏览器会去找 `/js/ui.js` 而 404,页面直接白屏。`store.js` 也据此推断后端位置(它会以页面目录为基准试多个候选,所以两种入口路径都能连上)。

### 静态模式

```powershell
serve-static.bat                   # 双击:自动构建 + 起预览 + 开浏览器
node scripts/build-static.mjs      # 只构建
node scripts/serve-static.mjs      # 只预览(默认 4518)
```

`dist/static/` 是纯静态文件,而且**它自己就是站点根** —— 整个目录丢到 GitHub Pages / Vercel / Netlify / 任意 nginx 即可,不用再往下进一层。构建时会把 `public/` 的内容铺到根上、`lib/` 放在旁边,并把 `js/*.js` 里指向 lib 的 `../../lib/` 重写成 `../lib/`(扁平布局下的相对路径变化)。构建脚本带两道自检:逐层解引用所有 JS import 与 HTML 的 src/href,以及禁止除探测之外的绝对 `/api` 依赖。

**注意**:`file://` 直接双击打开不行——ES module 在 `file://` 下会被 CORS 拦掉。必须走 HTTP,哪怕是本地预览也得用上面那个命令或任意静态服务器。

---

## 「刷新不清空」是怎么保证的

这是本项目的头号指标,做了四层。因为浏览器**不保证** `beforeunload` 里的异步请求能发出去,光靠防抖是堵不住"改完立刻 F5"这个窄缝的。

| 层 | 机制 | 堵住的场景 |
|---|---|---|
| 1 | 所有改动 debounce 300ms 自动存后端 | 正常编辑 |
| 2 | `visibilitychange`(hidden)/ `pagehide` 时**立即** flush | 切标签页、关窗口 |
| 3 | **每次改动同步写 localStorage 镜像** | 300ms 窗口内正好刷新 —— 这一层是关键 |
| 4 | `beforeunload` 未保存时拦一道 | 兜底提示 |

启动时如果服务端不可用,或服务端 revision 落后于本地镜像,会用镜像恢复并**明确提示**,不静默。保存失败会标红、写本地备份、每 3 秒重试,不会悄悄丢。

另外服务端落盘是**原子**的(写 `.tmp` → `fsync` → `rename`),写到一半断电不会毁掉项目文件;每次保存还留一份快照,保留最近 30 个,可以一路退回。

---

## 它解决的是什么问题

MIDI 里其实**已经有**逐字的时间信息,只是没人直接给你用。歌词藏在 meta 事件里,每个音节一个事件,各自带 delta-time。但直接拿来当字幕有两个障碍:

1. **时间是 tick,不是毫秒。** 要读 `MThd` 的 division(ppq)加上轨道里所有 `FF 51` 速度事件,按 tempo map **分段积分**。用单一 BPM 线性换算,一旦有变速就会越走越偏。
2. **节拍和断句对不上。** MIDI 里每个字是等权的,没有"行"的概念。而且导唱谱常常一个字给一整拍,直接导出字幕就是一闪一闪的。

所以本工具做两件事:**按 tempo map 正确换算成毫秒**,然后**给你一个时间轴让你手动修断句和时长**。

### 实测的坑(都已处理,有测试守着)

| 坑 | 说明 |
|---|---|
| 歌词不一定在 0x05 | `风平之后_带歌词.mid` 的歌词在 **0x01 text** 里。逐轨判定:有 0x05 用 0x05,没有才回退到 0x01 |
| 文本编码 | 中文 MIDI 常见 GBK。先按 UTF-8 解,出现替换字符再用 `TextDecoder('gbk')` 兜底 |
| 假歌词 | AI 生成工具的 MIDI 里有个 `FF 01` 事件塞了 AIGC 合规 JSON(`{"AIGC":{"Label":"1",…}}`),长得像歌词但不是,必须过滤 |
| 时间是 0 | 有的文件第一个歌词就在 tick 0 = 0ms。用 `if (!startMs)` 判空会把它当"未设置"丢掉 |
| 跨分钟/跨小时 | 60000ms 必须格式化成 `01:00.000` 而不是 `00:60.000`;超过一小时的时间戳各格式规则不同 |

---

## 导出格式

| 格式 | 样子 | 用途 |
|---|---|---|
| **SRT** | `00:00:20,786 --> 00:00:21,286` | 视频字幕,通用 |
| **VTT** | `00:00:20.786 --> 00:00:21.286` | 网页 `<track>`,首行 `WEBVTT` |
| **LRC** | `[00:20.78]慵` | 音乐播放器歌词,行级 |
| **增强 LRC** | `[00:20.78]<00:20.78>慵<00:21.28>懒` | 逐字卡拉OK,给支持逐字的播放器 |
| **ASS** | `{\k21}慵` | 带样式,可做卡拉OK 变色;`\k` 单位是厘秒 |

导出会尊重轨道的**可见**开关,隐藏的轨不导出。

---

## 目录结构

```
INTERFACE.md            冻结的接口契约(并行开发用,改签名前先读它)
package.json            零依赖,只有 scripts
lib/                    核心算法 —— 浏览器与 Node 双端共用的原生 ESM
  midi.mjs              MIDI 解析:变长整数、running status、tempo map 积分、编码兜底
  segments.mjs          音节 → 句子:按间隔与标点断句、拆分、合并、平移、规范化
  exporters.mjs         五种导出格式
  project.mjs           项目模型、版本迁移、字段补全
server/
  server.mjs            HTTP 服务:静态文件 + REST API,单端口
  store.mjs             项目落盘(原子写)+ 版本快照
  data/                 项目数据(不进版本库)
public/
  index.html            编辑器界面
  css/                  深色主题,剪辑软件风格
  js/state.js           AppState:唯一数据模型 + 撤销栈 + 脏标记
  js/render_timeline.js Canvas 绘制:泳道、片段、吸附线、播放头
  js/interact.js        拖动、拉边、框选、缩放、键盘
  js/store.js           持久化适配器(服务端 / localStorage 双实现)
  js/api.js             自动保存:防抖 + flush + 重试 + 镜像
  js/ui.js              外壳装配:工具栏、轨道面板、属性面板、状态栏
  js/importers.js       读 MIDI 文件
  js/exporter.js        导出与下载
  dev-harness.html      时间轴模块的独立自测页
scripts/
  build-static.mjs      产出 dist/static/(扁平布局 + 重写 lib 引用 + 两道产物自检)
  serve-static.mjs      静态版本地预览(含路径穿越防护)
  verify-track-align.mjs 真实 Chrome 驱动:轨道面板与 canvas 泳道对齐验证
  fixture-probe.mjs     打印 fixture 的 meta 事件分布(排查用)
tests/                  node:test
  fixtures/             真实 MIDI 测试素材
verification/           独立验证脚本与报告
```

---

## 操作方式

时间轴按 **MIDI 的每个 track 一条泳道**。

| 操作 | 做法 |
|---|---|
| **新建轨道** | 左侧轨道面板右上角的 **「＋ 新建轨道」** |
| **删除轨道** | 每条轨行尾的 **✕**(有片段的轨会先确认;删错了 Ctrl+Z 可撤销) |
| **调整轨道顺序** | 每条轨行尾的 **↑ / ↓** |
| **片段换轨** | **把片段往上/下拖到另一条泳道**。拖动时会原位留虚线幽灵、目标泳道显示实心预览;一次拖动 = 一条撤销记录。锁定的轨不接受落点 |
| 横向平移 | 拖时间轴下方的**滚动条**;或滚轮;或拖空白处 |
| 纵向切换泳道 | 拖右侧的**滚动条**;或 **Shift+滚轮** |
| 看到整条时间轴 | 舞台工具栏的 **「适配」**(缩放并回到起点);**「开头」**回到起点 |
| 选中 | 点击片段;Shift/Ctrl 多选;空白处拖动框选 |
| 改时间 | 拖片段主体 |
| 改时长 | 拖片段左右边缘 |
| 缩放 | Ctrl+滚轮(以鼠标位置为锚点),或工具栏 − / ＋ |
| 改文本 | 双击片段就地编辑,Enter 提交 Esc 取消 |
| 拆分 / 合并 | 属性面板按钮,或按 `[` `]` 设起止 |
| 撤销 / 重做 | Ctrl+Z / Ctrl+Y |
| 删除片段 | Delete / Backspace |
| 微调 | ← → 移动 10ms(按住 Shift 是 100ms) |
| 全选 | Ctrl+A |

拖动片段时会**吸附**到:其它片段的边界、整秒、以及该片段**原始的 MIDI 时间**(好让你随时对回原谱)。
**一次拖动只产生一条撤销记录**(横向改时间、纵向换轨,甚至两者同时,都只算一步)。

### 打开指定项目

```
http://127.0.0.1:4517/?project=<项目 id>
```

`?project=new` 强制开一个空项目。不带参数时自动恢复上次打开的项目;若上次离开时还有没写入服务端的改动,会用本地镜像恢复并明确提示。

---

## 测试

```powershell
npm test                          # 全部测试(node --test tests/)
node --test tests/lib/            # 只跑核心算法
node scripts/verify-clickable.mjs     # 真实 Chrome 驱动:页面真的可点击(命中测试 + CDP 真实鼠标事件)
node scripts/verify-track-align.mjs   # 真实 Chrome 驱动:轨道面板与 canvas 泳道对齐(含服务端/静态两种模式)
node verification/verify.mjs      # 独立验证:端到端 + 导出格式合法性 + 刷新恢复
```

`scripts/verify-clickable.mjs` 和 `scripts/verify-track-align.mjs` 会自己拉起服务端和无头 Chrome,用完自动清理,不需要额外准备。它们验证的都是**只有真浏览器才能发现**的问题:

- **可点击性**:曾经 `.modal-root { display: flex }` 压掉了浏览器默认的 `[hidden] { display: none }`,一个带 `hidden` 的全屏遮罩于是盖住整个界面,把所有鼠标点击都吃掉 —— 用户看到的是"整个网页都点不动"。程序化 `element.click()` 不经过命中测试,所以所有自测和端到端都照样通过却依然是坏的。这个脚本用 `elementFromPoint` 全屏采样 + **CDP 真实鼠标事件**来判定。
- **对齐**:DOM 与 Canvas 两个坐标系之间的错位,单元测试碰不到。

`tests/fixtures/` 里是 5 个**真实** MIDI,覆盖了上面那些坑:

| 文件 | 覆盖点 |
|---|---|
| `jianai-192ppq.mid` | 192ppq / 105BPM / 332 个中文歌词(0x05) |
| `yo12-480ppq.mid` | 480ppq / 110BPM / 247 个拼音歌词 |
| `ren-480ppq-aigc.mid` | 445 个歌词 + 1 个必须被过滤的 AIGC JSON |
| `fengping-lyrics.mid` | 歌词在 **0x01** 且首条在 **0ms** |
| `fengping-notlyrics.mid` | 纯钢琴,无歌词,不许崩 |

---

## 已知限制

- **没有音频、波形和播放。** 这是按需求刻意不做的。对齐只能看数字和原始 MIDI 时间。
- **不做声道分离或人声识别。** 只处理 MIDI 里已有的歌词事件。
- **静态模式的数据只在本浏览器。** 换浏览器或清站点数据就没了,重要项目建议用服务端模式并备份 `server/data/`。
- **服务端没有鉴权。** 只监听本地或你信任的网络;别直接暴露到公网。
- **服务端模式的地址栏里会带上 `/public/index.html`。** 因为应用页的相对资源必须在 `/public/` 这一级才能解析对(见上文)。直接访问 `/` 会自动跳转过去,不影响使用。
- **MIDI 格式**:支持 SMF type 0/1,不支持 type 2(多序列,极罕见)。
- 编码兜底只覆盖 UTF-8 与 GBK,其它编码(如 Shift-JIS)可能乱码。

## 许可

MIT
