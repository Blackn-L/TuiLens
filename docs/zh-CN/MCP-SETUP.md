# TuiLens MCP 接入指南

[English](../MCP-SETUP.md) · [简体中文](MCP-SETUP.md)

TuiLens 通过 MCP stdio 服务提供终端自动化能力。MCP 客户端会把 `tuilens mcp` 作为子进程启动，
不存在可连接的 URL 或端口。请在终端会话实际运行的机器上安装 TuiLens。

## 环境要求

- Node.js 22 或更高版本。
- Windows、Linux 或 macOS（实验性）。
- **纯文本会话不需要浏览器。**
- 截图、图片协议和视觉比较需要 Chrome、Edge 或 Chromium。没有系统浏览器时再安装 Playwright
  Chromium：

  ```sh
  npx playwright-core install chromium
  ```

- `node-pty` 没有可用预编译包时，需要对应平台的 C++ 构建工具。

## 安装

全局安装：

```sh
npm install -g tuilens
tuilens doctor
```

免全局安装：

```sh
npx -y tuilens doctor
npx -y tuilens mcp
```

pnpm 10+ 默认阻止依赖运行构建脚本。安装后批准 `node-pty`：

```sh
pnpm add -g tuilens
pnpm approve-builds -g
```

在提示中选择 `node-pty`。如果 TuiLens 是项目依赖，在项目目录运行 `pnpm approve-builds`。

`tuilens doctor` 会检查 Node.js、平台支持、浏览器发现、`node-pty`、存储权限和 daemon 状态，
但不会启动 daemon。退出码 1 表示存在错误级检查失败。

## 生成客户端配置

优先让 `mcp-config` 生成命令和路径：

```sh
tuilens mcp-config --client codex
tuilens mcp-config --client claude-code
tuilens mcp-config --client cursor
tuilens mcp-config --client gemini
tuilens mcp-config --client json
```

启动模式：

- `--mode global`（默认）：命令 `tuilens`，参数 `["mcp"]`。适用于全局安装。
- `--mode npx`：命令 `npx`，参数 `["-y", "tuilens", "mcp"]`。不需要全局安装。
- `--mode absolute`：输出 `process.execPath` 和已安装 `cli.js` 的绝对路径。适用于 Cursor、
  Claude Desktop 等不继承 shell `PATH` 的 GUI 客户端。

示例：

```sh
tuilens mcp-config --client codex --mode global
tuilens mcp-config --client json --mode absolute
```

## 客户端配置

### Codex

```sh
tuilens mcp-config --client codex
```

把输出的 TOML 写入 Windows 的 `%USERPROFILE%\.codex\config.toml`，或 Linux/macOS 的
`~/.codex/config.toml`：

```toml
[mcp_servers.tuilens]
command = "tuilens"
args = ["mcp"]
```

如果 GUI 或沙箱化的 Codex 进程找不到 `tuilens`，改用：

```sh
tuilens mcp-config --client codex --mode absolute
```

修改后重启 Codex。

### Claude Code

```sh
tuilens mcp-config --client claude-code
```

生成的命令形式：

```sh
claude mcp add --scope user tuilens -- tuilens mcp
```

需要免全局安装或修复 GUI `PATH` 时，分别使用 `--mode npx` 或 `--mode absolute`。
添加后重启 Claude Code 或新开会话。

### Cursor

```sh
tuilens mcp-config --client cursor
```

把 JSON 粘贴到 `~/.cursor/mcp.json`，或项目级 `.cursor/mcp.json`：

```json
{
  "mcpServers": {
    "tuilens": {
      "command": "tuilens",
      "args": ["mcp"]
    }
  }
}
```

Cursor 是 GUI 客户端。如果报 `spawn tuilens ENOENT`，重新用 `--mode absolute` 生成配置。

### Gemini CLI

```sh
tuilens mcp-config --client gemini
```

把 `mcpServers` JSON 粘贴到 `~/.gemini/settings.json`（用户级）或
`.gemini/settings.json`（项目级）。接受标准 `mcpServers` 配置的其他客户端也可使用同样结构。

### 其他客户端

```sh
tuilens mcp-config --client json
```

保持 `command` 与 `args` 不变，只替换配置文件位置即可。

## 推荐 Agent 主循环

MCP 初始化 instructions 和工具描述会提示 Agent 使用：

```text
terminal_launch
  -> terminal_observe(view:"compact")       # 保存 snapshot.frameId
  -> terminal_inputAndWait                  # 只发送一次输入并等待证据
  -> terminal_observe(view:"diff",
       fromFrameId:<上一次 frameId>)        # 只返回变化和元数据
  -> terminal_close
```

只有明确的视觉检查才传 `screenshot:true`。可重复流程用 `terminal_scenario`，延迟或内存测量用
`terminal_perf`。简单非交互命令仍应使用普通 shell。

## Resources 与 Prompts

MCP 服务提供只读资源：

| URI | 内容 |
| --- | --- |
| `tuilens://sessions` | 安全会话元数据，不含环境变量或凭据。 |
| `tuilens://sessions/{id}/screen` | 无浏览器的 compact 文本画面。 |
| `tuilens://sessions/{id}/screenshot` | 当前 PNG，32 MiB 上限。 |
| `tuilens://sessions/{id}/metrics` | 背压、队列与协议应答计数。 |
| `tuilens://artifacts/{name}` | 报告、差异图、截图或录制，16 MiB 上限。 |

artifact 名称必须相对于 `TUILENS_HOME/artifacts`。绝对路径、`..`、NUL 字节和符号链接逃逸会在
`resolve` 与 `realpath` 两层包含检查后被拒绝。

Prompts：

- `tui_reproduce_bug`
- `tui_visual_regression`

Prompt 文案和描述跟随 `TUILENS_LANG`（默认英文，`zh-CN` 为中文）。

## 进度与取消

客户端提供 `_meta.progressToken` 时，`wait`、`inputAndWait`、`replay`、`scenario` 和 `perf`
会转发真实服务端进度。通知包含 `progress` 与 `total`，不使用固定心跳。
取消 MCP 请求会中止对应的 daemon 操作。

## 验证接入

重启客户端后：

1. 确认工具列表包含 `terminal_launch`、`terminal_observe`、`terminal_inputAndWait`、
   `terminal_wait`、`terminal_compare`、`terminal_scenario`、`terminal_perf` 和
   `terminal_close`。
2. 用以下参数调用 `terminal_launch`，启动一个小型 Node.js 程序：

   ```json
   {
     "command": "node",
     "args": ["-e", "process.stdout.write('READY\\n');setInterval(()=>{},1000)"],
     "cols": 80,
     "rows": 16
   }
   ```

3. 复制启动结果中的 `id`，填入 `terminal_wait` 的参数，等待程序绘制画面。

   ```json
   { "id": "<会话 ID>", "conditions": [{ "kind": "text", "text": "READY" }] }
   ```

4. 用 `{"id":"<会话 ID>"}` 调用 `terminal_observe`。接入成功时，返回的
   `snapshot.lines[0]` 为 `READY`。用同一 ID 调用 `terminal_close` 结束会话。

纯文本观察不需要浏览器。截图请求会激活 Chromium 并返回实际 `renderer`；没有浏览器时截图失败，
但文本观察仍然可用。

## 多 Agent 协作

TuiLens 的隔离边界是 terminal 会话 ID，不是 Agent 身份。所有 MCP 连接共享同一个 daemon，
`terminal_list` 返回全局会话，任何持有有效 ID 的调用者都能观察或关闭它。

- 每个 Agent 应自行 launch 并 close 自己的会话。
- 同一会话同一时刻只保留一个写者。
- 交接视为显式所有权转移。
- 不要从 `terminal_list` 接管其他 Agent 正在运行的会话。
- MCP 连接断开时只回收该连接创建的会话。

默认会话额度为 8，可用 `TUILENS_MAX_SESSIONS` 调整。额度满时只回收最旧的已退出会话，
不会抢占运行中的会话。

## 常见问题

| 现象 | 可能原因 | 处理方式 |
| --- | --- | --- |
| `spawn tuilens ENOENT` | GUI 客户端没有继承 shell `PATH` | 使用 `tuilens mcp-config --client <客户端> --mode absolute` |
| `Cannot find module .../cli.js` | 绝对配置指向已删除的安装 | 重新安装 TuiLens 并用 `--mode absolute` 重新生成 |
| 重启后没有工具 | 客户端没有重新加载 MCP 配置 | 重启客户端或新开会话 |
| `node-pty` 安装失败 | pnpm/npm 阻止了构建脚本，或缺少 C++ 工具 | 用 `pnpm approve-builds -g` 批准 `node-pty`，或安装构建工具 |
| 浏览器启动失败 | 没有检测到 Chrome/Edge/Chromium | 安装浏览器或运行 `npx playwright-core install chromium` |
| 相对命令找不到 | 客户端工作目录与 shell 不同 | 在工具参数中使用绝对 `cwd` 和程序路径 |
| `mcp` 看起来一直挂起 | stdio 服务正在等待 JSON-RPC 输入 | 通过 MCP 客户端测试，不要当成交互式命令 |
| 不确定环境是否就绪 | 运行时、PTY、存储或 daemon 状态异常 | 运行 `tuilens doctor` |

## 安全

MCP 服务可以用当前用户权限启动任意本地程序。只安装可信包，并在运行场景前检查其内容。

传输只在本机进行：Windows 使用命名管道，Linux 使用 abstract Unix socket，macOS 使用带本地
令牌的私有 Unix socket。没有公开的 HTTP/SSE 控制端点，不要把 daemon socket 暴露给其他机器。

CLI 与 MCP 参数格式见[协议示例](PROTOCOL.md)。
