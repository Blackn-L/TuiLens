# 快速开始

[English](../GETTING-STARTED.md) · [简体中文](GETTING-STARTED.md)

通过 [MCP](#mcp) 让 Agent 操作终端，通过 [CLI](#cli) 在 shell 中复现交互，或用 [SDK](#sdk) 编写测试。下面三个示例都使用 Node.js 自带的交互提示符，装有 Node.js 22 或更高版本即可在任意目录尝试。

## MCP

先生成适合客户端的配置。以下命令为 Codex 输出 TOML，客户端会按需通过 npm 启动服务。

```sh
npx -y tuilens mcp-config --client codex --mode npx
```

将输出加入 Codex 的 `~/.codex/config.toml`。Windows 的位置是 `%USERPROFILE%\.codex\config.toml`。重启客户端后，可以这样要求 Agent：

> 用 TuiLens 启动 `node`，参数为 `["-i"]`。等待画面出现 “Welcome to Node.js”，输入 `6 * 7` 并按 Enter。读出 Node 显示答案的那一行，然后关闭会话。

Agent 应当读到 `42`。MCP 启动结果中的 `id` 是会话标识，观察结果包含 `snapshot.lines` 和 `snapshot.frameId`。Agent 可以记下帧 ID，用 `terminal_inputAndWait` 发送操作，再从上一帧开始查询变化。需要图片时可以显式请求截图。

其他客户端可选 `--client claude-code`、`cursor`、`gemini` 或 `json`。如果桌面客户端从 `PATH` 找不到命令，可以全局安装后用 `--mode absolute` 生成绝对路径配置。[客户端配置、只读资源与排错](MCP-SETUP.md)

## CLI

全局安装 CLI 并检查本机环境。

```sh
npm install -g tuilens
tuilens doctor
```

启动 Node 交互提示符，将会话 ID 保存为 shell 变量。给 `"--"` 加引号，可以让 npm 的 PowerShell 启动脚本原样传递参数分隔符。

**PowerShell**

```powershell
$sessionId = (tuilens launch --cols 64 --rows 8 "--" node -i | ConvertFrom-Json).data.id
```

**Bash 或 Zsh**

```sh
sessionId=$(tuilens launch --cols 64 --rows 8 "--" node -i | node -p "JSON.parse(require('node:fs').readFileSync(0, 'utf8')).data.id")
```

在同一个 shell 继续运行以下命令。第一次等待确认 Node 已准备好接收输入，第二次等待确认它已将结果写到屏幕上。

```sh
tuilens wait "$sessionId" --text "Welcome to Node.js"
tuilens type "$sessionId" "6 * 7"
tuilens key "$sessionId" Enter
tuilens wait "$sessionId" --text 42
tuilens observe "$sessionId"
tuilens close "$sessionId"
```

查看观察结果中的 `data.snapshot.lines`，可以找到输入的算式和下一行的答案。

```text
> 6 * 7
42
```

如需 PNG，在关闭会话前给 `observe` 加上 `--screenshot`，即可从 `data.screenshot.path` 取得图片路径。截图与文本共享帧 ID。截图区域用从零开始的字符格坐标表示，视觉比较的遮罩使用裁剪后 PNG 的像素坐标。

对于按键后立即更新的程序，`input-wait` 可以发送一次文本并等待可见结果。需要 Enter 提交整行时，分别使用 `type` 和 `key`。运行 `tuilens --help` 可查看各条命令，也可以通过 `--json`、`--file` 或 `--stdin` 传递结构化参数。[输入保护、等待条件与观察格式](PROTOCOL.md)

## SDK

将 TuiLens 安装为测试项目的依赖。

```sh
npm install --save-dev tuilens
```

将以下代码保存为 `terminal.test.mjs`。TypeScript 项目可以直接使用包自带的类型声明。

```js
import test from "node:test";
import { SessionManager, terminal } from "tuilens";

test("Node evaluates an expression in the terminal", async () => {
  const manager = new SessionManager({ artifactDir: "./artifacts" });
  try {
    const tui = await terminal(manager, {
      command: process.execPath,
      args: ["-i"],
      cols: 64,
      rows: 8,
    });
    await tui.expectText("Welcome to Node.js");
    await tui.type("6 * 7");
    await tui.key("Enter");
    await tui.expectText("42");
  } finally {
    await manager.closeAll();
  }
});
```

```sh
node --test terminal.test.mjs
```

屏幕出现预期文本时，测试通过。要断言某段文字一直没有出现，`expectNoText("Error", { timeoutMs: 500 })` 会观察完整的 500 毫秒。断言失败会返回预期值和实际值，能获取截图时还会附上画面摘录和截图路径。用 `tui.screen()` 读取文字与光标状态，`tui.screenshot()` 截取 PNG，或用 `manager.observe(tui.id, { view: "cells" })` 取得字符格。

## 复现示例报告

[场景报告](https://blackn-l.github.io/TuiLens/examples/scenario.html) 展示了仓库自带示例的一次运行。要在本地复现，先克隆仓库，取得场景文件和它启动的程序。

```sh
git clone https://github.com/Blackn-L/TuiLens.git
cd TuiLens
npm ci
npm run build
node dist/src/interfaces/cli.js scenario --file examples/scenario.json --html scenario.html
```

打开 `scenario.html` 查看步骤和截图。CI 中可以加上 `--junit scenario.xml`。如果要测量示例程序的性能，用同一个 CLI 运行 `perf --file examples/perf.json --html perf.html`。[场景源文件](https://github.com/Blackn-L/TuiLens/blob/main/examples/scenario.json) · [录制与场景](RECORDING.md) · [性能测量](PERFORMANCE.md) · [报告格式](REPORTING.md)

## 安装与诊断

| 情况 | 操作 |
| --- | --- |
| 临时运行一次 | 使用 `npx -y tuilens doctor`。 |
| pnpm 10+ 阻止了 `node-pty` 的构建脚本 | 全局安装时运行 `pnpm add -g tuilens` 和 `pnpm approve-builds -g`，然后选择 `node-pty`。项目依赖需在对应项目中批准构建。 |
| 在项目中使用 npm 12+ | 安装前将 `"allowScripts": { "node-pty@1.2.0-beta.18": true }` 加入使用方项目根目录的 `package.json`。没有可用的预编译原生模块时，还需安装平台的 C++ 构建工具。 |
| 需要截图、图片协议或视觉比较 | TuiLens 会查找本机的 Chrome、Edge 或 Chromium。用 `TUILENS_BROWSER_PATH` 指定可执行文件，或在缺少兼容浏览器时运行 `npx playwright-core install chromium`。 |
| 检查运行环境 | `tuilens doctor` 检查 Node、原生模块加载、浏览器路径、存储和后台服务元数据。发现错误时退出码为 1。上面的 CLI 示例还会实际启动一个 PTY。 |
| 检查字体 | `tuilens probe` 会渲染固定字形并给出字体与字符格指纹。用 `TUILENS_FONT_FILE` 固定字体，用 `TUILENS_FONT_FAMILY` 指定回退字体栈。修改字体后需要重启后台服务。[字体与基准图设置](VISUAL.md) |

CLI 与 MCP 使用本地后台服务。`close` 只释放指定会话。`shutdown` 会关闭该后台服务中的所有会话。需要隔离一次运行时，在启动环境中设置 `TUILENS_HOME`，默认目录是 `~/.tuilens`。可通过 `TUILENS_IPC_TIMEOUT_MS` 设置 IPC 超时。[会话生命周期与限制](ARCHITECTURE.md)

消息默认使用英文。PowerShell 可执行 `$env:TUILENS_LANG = "zh-CN"`，Bash 或 Zsh 可执行 `export TUILENS_LANG=zh-CN` 切换到简体中文。MCP 工具描述的语言可在客户端环境变量中设置。结构化错误包含 `messageEn` 和 `messageZh`，`message` 使用当前语言。
