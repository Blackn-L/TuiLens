# TuiLens

**面向 AI Agent 的终端自动化工具。**

[English](README.md) · [简体中文](README.zh-CN.md) · [MIT 许可证](LICENSE)

TuiLens 在真实 PTY 中运行终端程序，通过 JSON CLI、MCP 和 TypeScript SDK
提供截图、终端状态、键盘与鼠标输入。

![TuiLens：面向 AI Agent 的终端自动化工具](docs/assets/tuilens-agent-banner.png)

> **状态：** 0.4.0 实验版本，用于功能和视觉测试。
> 浏览器渲染链路不属于低干扰性能测量环境。

[功能](#功能) · [安装](#安装) · [快速开始](#快速开始) · [接口](#接口) · [开发](#开发) · [文档](#文档) · [许可证](#许可证)

## 功能

- **原生图片：** 按需启用 SIXEL、iTerm2 OSC 1337 内联图片和有界 Kitty 子集，支持 Unicode 虚拟放置。
- **绘制后端：** 默认继续使用 DOM；可按需启用 WebGL，获得连续块字符和高保真截图。实际 renderer 会随会话和视觉产物回传、记录。
- **视觉测试：** 字符格区域截图、PNG 比较、像素遮罩、差异图与报告。
- **输入操作：** 按键、括号粘贴、点击、按住/释放、拖拽、带位置滚轮和修饰键。
- **录制回放：** 有容量限制的输出/输入/resize 记录；离线回放不执行录制的输入。
- **可靠定位：** 区域和样式筛选、唯一/nth 匹配、帧或区域保护、组合条件等待。
- **交互确认：** `input-wait` 发送一次输入后等待可见结果，支持文本、尺寸、稳定和光标条件。
- **命中区控制：** `clickText` 可用 hitbox/point/offset 指定文字旁的真实可点击区域。
- **未提交帧点击：** 同步帧阻止正常定位时，可显式使用 `allowPendingFrame`。
- **滚动导航：** 滚轮支持按页单位和应用回滚区的首尾定位。
- **键盘协议：** 除传统 xterm 编码外支持 Kitty keyboard protocol（`CSI u`）与 `modifyOtherKeys`，
  使 `Shift+Enter`、`Ctrl+Enter`、`Ctrl+Space` 能送达已协商这些协议的应用。
- **终端能力画像：** 内置 preset 或派生 JSON profile 统一驱动 `TERM`、DA1/DA2/XTVERSION/Kitty 查询应答、
  图片协议、键盘能力元数据和回滚缓冲；场景/性能测试可运行 profile 矩阵。
- **回滚区断言：** `observe.scrollback` 返回视口上方的历史行，滚出屏幕的内容仍可断言。
- **终端应答护栏：** 默认丢弃超时或无查询匹配的 DA1/DA2、CPR/DSR 等自动应答；`suppress` 保留普通输入。
- **场景执行：** 声明式步骤、失败截图、报告和自动清理。
- **性能测试：** 多轮声明式场景，支持历史增长准备、进程树内存采样、可选基线文件与劣化判定。
- **断言层：** playwright 风格的 `Terminal` 句柄，失败时给出期望/实际/截图，并可输出 JUnit XML。
- **Agent 接口：** CLI/MCP 共用接口，同时提供 SDK。

## 环境要求

- Node.js **22 或更高版本**。
- Windows 或 Linux，以及本机 Chrome/Chromium 或 Playwright Chromium。
- node-pty 无可用预编译包时，需要相应平台的 C++ 构建工具。

## 安装

当前从源码安装。满足上述环境要求后执行：

```sh
git clone https://github.com/Blackn-L/TuiLens.git
cd TuiLens
npm ci
npm run build
```

默认检测系统 Chrome/Edge；也可以安装 Playwright Chromium：

```sh
npx playwright install chromium
```

通过 `TUILENS_BROWSER_PATH` 指定浏览器。

## 快速开始

先查看 CLI 帮助：

```sh
node dist/src/interfaces/cli.js --help
```

然后从仓库根目录运行独立场景：

```sh
node dist/src/interfaces/cli.js scenario --file examples/scenario.json
```

JSON 结果包含报告路径和步骤证据。场景或视觉比较失败时退出码为 1。

启动交互会话：

```sh
node dist/src/interfaces/cli.js launch --record --cols 80 --rows 16 -- node examples/echo-tui.mjs
```

用 `--terminal-profile kitty`、`wezterm`、`iterm2` 或 JSON profile 路径选择终端身份。
全部 preset、继承方式和矩阵示例见[终端能力画像](docs/zh-CN/PROFILES.md)。

将返回的 `data.id` 替换到下面的 `SESSION_ID`：

```sh
node dist/src/interfaces/cli.js observe SESSION_ID
node dist/src/interfaces/cli.js type SESSION_ID g
node dist/src/interfaces/cli.js wait SESSION_ID --text UPDATED
node dist/src/interfaces/cli.js input-wait SESSION_ID PING --text INPUT_RECEIVED
node dist/src/interfaces/cli.js drag SESSION_ID 2 3 20 3 --shift
node dist/src/interfaces/cli.js observe SESSION_ID --region 0,7,30,4
node dist/src/interfaces/cli.js key SESSION_ID Ctrl+q
node dist/src/interfaces/cli.js wait SESSION_ID --exited
node dist/src/interfaces/cli.js close SESSION_ID
node dist/src/interfaces/cli.js shutdown
```

坐标从 **0** 起算，单位为字符格。普通输入返回表示已送达；需要确认渲染结果时使用
`input-wait` 或显式等待。它不会自动重发输入。
终端自动应答默认使用 `--protocol-replies auto`，只转发及时且存在查询匹配的已知应答。
若应用在 TTY 已回显时查询，使用 `--protocol-replies suppress` 或应用侧探测开关。

## 接口

所有接口共用同一套 PTY 引擎和会话状态。按调用方需要选择最小接口。

| 接口 | 适用场景 | 入口 | 详情 |
| --- | --- | --- | --- |
| CLI | Shell 脚本、CI 任务和手动探测 | `node dist/src/interfaces/cli.js <command>` | [快速开始](#快速开始) · [协议示例](docs/zh-CN/PROTOCOL.md) |
| MCP | 需要工具调用和图片内容的 Agent | 通过 stdio 启动 `node /absolute/path/to/TuiLens/dist/src/interfaces/cli.js mcp` | [MCP 接入指南](docs/zh-CN/MCP-SETUP.md) |
| TypeScript SDK | 测试套件和内嵌自动化 | `import { SessionManager, terminal } from "./dist/src/index.js"` | [测试断言](#测试断言) · [SDK 示例](#typescript-sdk) |

## 语言

CLI 帮助、MCP 工具描述、错误和断言信息默认使用英文。设置 `TUILENS_LANG=zh-CN`
可切换到简体中文：

```powershell
$env:TUILENS_LANG = "zh-CN"
```

```sh
export TUILENS_LANG=zh-CN
```

`TUILENS_LANG` 对大小写不敏感，接受 `en`、`zh` 和 `zh-CN`；不支持的值会回退到英文。
使用 MCP 时，可在客户端的环境变量中设置该值，使该连接的工具描述和错误响应使用中文。
CLI、MCP 和 SDK 的结构化错误同时提供 `messageEn` 与 `messageZh`，`message` 跟随当前语言。

## 图片与截图

使用 `launch --images sixel`、`launch --images iterm` 或 `launch --images all`，默认 `off`。
`iterm` 启用 OSC 1337 内联图片及分段传输。`all` 包含三种已实现的图片协议，
不代表完整 Kitty 或 OSC 1337 扩展兼容。

`launch --renderer webgl` 启用 xterm.js WebGL 绘制；默认是 `--renderer dom`。需要在截图中保证块字符/框线连续时
建议使用 WebGL。它可能把字符格宽取整（例如 160 列从 1500px 变为 1440px），切换后应重新录制视觉基准。
`session.renderer`、录制头、scenario/perf 环境、观察 JSON 和比较 JSON 都会记录实际 renderer。
WebGL 无法启动时会回退 DOM 并回传 `dom`，不会静默声称使用了 WebGL。

```sh
node dist/src/interfaces/cli.js observe SESSION_ID --region 0,0,40,10
node dist/src/interfaces/cli.js compare SESSION_ID --baseline baseline.png --region 0,0,40,10
```

截图和状态共享 `frameId`。区域裁剪只改变 PNG，状态仍包含完整视口。
`--cells` 可额外返回完整字符格；完整截图元数据也保存在本地。
基准图只读，接受新基准必须显式复制已审查的截图。
比较遮罩以 **PNG 像素**计量，与字符格坐标不同。请固定字体、浏览器和网格以解释像素差异。

详见[图片支持](docs/zh-CN/IMAGES.md)和[视觉比较](docs/zh-CN/VISUAL.md)。

## 定位与等待

```sh
node dist/src/interfaces/cli.js find SESSION_ID Run --unique
node dist/src/interfaces/cli.js click-text SESSION_ID Run --nth 1
node dist/src/interfaces/cli.js click-text --json '{"id":"SESSION_ID","text":"Collapse","options":{"hitbox":{"right":3},"point":"right"}}'
node dist/src/interfaces/cli.js wait SESSION_ID --stable 250 --region 0,0,40,10
```

`click-text` 默认要求唯一匹配；发现文字不等于识别业务按钮。
可用 `hitbox`/`point`/`offset` 扩展命中区或选择文字右侧的箭头，并可指定鼠标按钮。
JSON 接口还支持 `style`、`count`、`afterFrameId` 和输入保护条件。
区域指纹可阻止对已变化目标的操作，同时容许其他区域继续动画。
同步帧始终不结束时，可在 `clickText` 的 `options.allowPendingFrame:true` 显式放宽同步帧读取。
它读取未提交的字符缓冲，仍校验目标区域指纹；不提供稳定 PNG，也不绕过 `frameId` 保护。
普通观察与截图仍要求同步帧结束。

```json
{ "type": "scroll", "x": 20, "y": 10, "direction": "down", "unit": "page", "amount": 5 }
{ "type": "scroll", "x": 20, "y": 10, "to": "top" }
```

滚动坐标选择应用中的悬停区域。按页滚动按终端行数展开；首尾导航使用有界滚轮事件序列，
仍受应用消费方式和回滚区容量限制。单次 `amount` 上限为 100；需要拖动滚动条时使用显式 drag。

所有命令均可通过 `--json`、`--file` 或 `--stdin` 传入结构化参数。
详见[协议示例](docs/zh-CN/PROTOCOL.md)。

## 录制与场景

`launch --record` 从第一批已处理输出开始记录，返回 `recordingPath`。
录制包含终端正文与输入内容，启用前应考虑会话数据。
默认上限 16 MiB，可配置 4 KiB–64 MiB，达到上限会明确标注截断。

```sh
node dist/src/interfaces/cli.js replay path/to/session.recording.jsonl
node dist/src/interfaces/cli.js replay path/to/session.recording.jsonl --speed 2
```

回放只将输出和 resize 应用到新引擎，不重新运行程序、命令或输入。
`speed=0` 表示立即应用；截断回放需要显式设置 `--allow-truncated`。

[场景示例](examples/scenario.json) · [录制与场景规则](docs/zh-CN/RECORDING.md)

## 性能测试

TUI agent 会不断积累会话历史，响应时间往往随会话变长而劣化。
`perf` 用固定工作负载跑多轮（每轮重启被测程序），可与**你自己生成的基线**比较。
TuiLens 仓库不提交基线：测量结果依赖被测程序、平台、网格和 runner。

```sh
# 为你的工作负载生成基线，路径由你决定。
node dist/src/interfaces/cli.js perf --file examples/perf.json --write-baseline artifacts/perf-baseline.json

# 后续运行与基线比较。
node dist/src/interfaces/cli.js perf --file examples/perf.json \
  --baseline artifacts/perf-baseline.json --max-regression 0.15 --junit artifacts/junit-perf.xml
```

要在自己的仓库里用基线做 CI 门禁，请改用受版本控制的路径；`artifacts/` 只用于本地或演示运行，
不会被 Git 跟踪。

每轮都重新启动被测程序，进程内状态不会跨轮次泄漏。每个采样都是「输入发出 → 证据可见」，
也就是用户真实感受到的延迟。`setup` 在测量前重建状态（例如 40 轮历史），
`{{seq}}` 会展开为本次运行内的输入序号，确保每次采样等待的是**它自己**产生的新证据，
而不是屏幕上早已存在的文本。

```json
{
  "version": 1,
  "launch": { "command": "node", "args": ["examples/perf-tui.mjs"], "cols": 80, "rows": 24 },
  "ready": [{ "kind": "text", "text": "TURN_0" }],
  "warmupRounds": 1, "rounds": 3, "repeats": 3,
  "phases": [{
    "name": "short-history",
    "samples": [{ "input": { "type": "text", "text": "x" },
      "observe": [{ "kind": "text", "text": "TURN_{{seq}}" }] }]
  }]
}
```

结果包含各阶段的 p50/p95/p99、抖动分级（max ÷ p50）、**被测程序进程树**的内存峰值
（不只是工具自身），以及提供基线时每个指标相对基线的变化。提供基线时，p50 超过
`--max-regression` 会以非零退出码失败。

基线是可选测量快照，不是必需配置。它记录平台与网格；环境不一致时默认拒绝比较，
确需比较时使用 `--allow-env-mismatch`。测量边界见[性能文档](docs/zh-CN/PERFORMANCE.md)。

## 测试断言

SDK 提供接近 playwright 的句柄：

```ts
import { SessionManager, terminal } from "./dist/src/index.js";

const manager = new SessionManager({ artifactDir: "./artifacts" });
const tui = await terminal(manager, { command: "my-tui", cols: 100, rows: 30 });
await tui.expectText("Ready");
await tui.type("hello");
await tui.key("Shift+Enter");           // 需要应用已协商 CSI u
await tui.expectText("Response", { timeoutMs: 10_000 });
await tui.expectNoText("Error", { timeoutMs: 500 });
```

`expectNoText` 会等满整个窗口才判定通过：只是还没渲染出来的文本不能被当成「不存在」。
断言失败会带上期望、实际、截图路径与画面摘录。

场景与性能运行都可以用 `--junit <路径>` 输出 JUnit XML，供 CI 展示。

## MCP

先构建 TuiLens，再让 MCP 客户端使用绝对路径启动 stdio 服务：

```json
{
  "mcpServers": {
    "tuilens": {
      "command": "node",
      "args": ["/absolute/path/to/TuiLens/dist/src/interfaces/cli.js", "mcp"]
    }
  }
}
```

安装、Codex 与 JSON 客户端配置、验收方法、排错和本机安全说明见
[MCP 接入指南](docs/zh-CN/MCP-SETUP.md)。

工具包括 `terminal_launch`、`terminal_list`、`terminal_observe`、`terminal_find`、
`terminal_clickText`、`terminal_input`、`terminal_inputAndWait`、`terminal_resize`、`terminal_wait`、`terminal_compare`、
`terminal_replay`、`terminal_scenario`、`terminal_perf`、`terminal_metrics`、`terminal_close`。
观察、回放和启用截图的 inputAndWait 返回 PNG image content 和文字元数据；MCP 断开时回收该连接创建的会话。

## TypeScript SDK

```ts
import { SessionManager } from "./dist/src/index.js";

const manager = new SessionManager({ artifactDir: "./artifacts" });
try {
  const session = await manager.launch({
    command: "node", args: ["examples/echo-tui.mjs"], cols: 80, rows: 16,
  });
  await manager.wait(session.id, { conditions: [{ kind: "text", text: "READY" }] });
  await manager.input(session.id, { type: "text", text: "g" });
  await manager.wait(session.id, { conditions: [{ kind: "text", text: "UPDATED" }] });
  console.log((await manager.observe(session.id)).screenshot?.path);
} finally {
  await manager.closeAll();
}
```

## 开发

```sh
npm run check
npm test
npm run benchmark:overhead -- --frames 120 --repeats 3 --pace-ms 1
```

测试使用独立夹具，截图、录制、报告与编译产物均被 Git 忽略。
后台服务使用本机命名管道或 Linux abstract Unix socket，并使用本地令牌认证。
`TUILENS_HOME` 可隔离状态目录，默认 `~/.tuilens`；没有公开 HTTP 控制端口。

## 文档

| 主题 | 简体中文 | English |
| --- | --- | --- |
| 架构 | [架构](docs/zh-CN/ARCHITECTURE.md) | [ARCHITECTURE.md](docs/ARCHITECTURE.md) |
| MCP 接入 | [MCP 接入](docs/zh-CN/MCP-SETUP.md) | [MCP-SETUP.md](docs/MCP-SETUP.md) |
| 协议 | [协议示例](docs/zh-CN/PROTOCOL.md) | [PROTOCOL.md](docs/PROTOCOL.md) |
| 终端能力画像 | [终端能力画像](docs/zh-CN/PROFILES.md) | [PROFILES.md](docs/PROFILES.md) |
| 录制与场景 | [录制与场景](docs/zh-CN/RECORDING.md) | [RECORDING.md](docs/RECORDING.md) |
| 图片支持 | [图片支持](docs/zh-CN/IMAGES.md) | [IMAGES.md](docs/IMAGES.md) |
| 视觉比较 | [视觉比较](docs/zh-CN/VISUAL.md) | [VISUAL.md](docs/VISUAL.md) |
| 验证 | [验证](docs/zh-CN/VALIDATION.md) | [VALIDATION.md](docs/VALIDATION.md) |
| 性能 | [性能](docs/zh-CN/PERFORMANCE.md) | [PERFORMANCE.md](docs/PERFORMANCE.md) |
| 路线 | [路线](docs/zh-CN/ROADMAP.md) | [ROADMAP.md](docs/ROADMAP.md) |

## 限制

- Kitty 为明确列出的子集，不支持外部文件/共享内存、动画、压缩和任意图层。
- 鼠标要求字符格 SGR 模式；系统输入法候选窗与系统剪贴板不属于当前渲染器。
- 截图默认隐藏光标本体；快照仍返回可见性、样式和闪烁状态，但无法验证真实宿主光标或 IME。
- `protocolReplies: "auto"` 只为及时且有查询匹配的已知自动应答放行；`suppress` 只丢弃完整已知应答，不过滤任意输入。若应用在 TTY 已回显时查询，仍需 `suppress` 或应用侧开关。
- 浏览器解析、绘制、截图和录制都有开销；轻量 metrics 不消除渲染成本。
- 输出回放不等同于应用重跑；区域稳定不证明所有后台工作结束。
- Windows node-pty 1.1.0 清理期间可能输出 `AttachConsole failed`，需确认进程退出并保留诊断。

## 许可证

本项目采用 [MIT 许可证](LICENSE) 开源；版权所有 (c) 2026 Blackn-L。

第三方组件保留各自的上游许可证，见 [THIRD_PARTY.md](THIRD_PARTY.md)。

## 贡献

请阅读[贡献说明](docs/zh-CN/CONTRIBUTING.md)，提交独立复现与验证证据。
安全报告见 [SECURITY.md](SECURITY.md)。
