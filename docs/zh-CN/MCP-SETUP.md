# TuiLens MCP 接入指南

[English](../MCP-SETUP.md) · [简体中文](MCP-SETUP.md)

TuiLens 通过 MCP stdio 服务提供终端自动化能力。MCP 客户端会把这个服务作为子进程启动，
不存在可连接的 URL 或端口。每个使用者都需要在终端会话实际运行的机器上安装一份 TuiLens。

## 环境要求

- Node.js 22 或更高版本，以及 npm。
- Windows 或 Linux。
- 从源码安装时需要 Git。
- 本机 Chrome、Edge，或 Playwright Chromium。
- 如果 `node-pty` 没有可用的预编译包，需要对应平台的 C++ 构建工具。

## 构建服务

当前 0.4.0 版本从仓库分发，尚未发布到 npm registry。`dist/` 是生成目录，不在 Git 仓库中；
因此只下载源码压缩包不够，还必须安装依赖并构建。

```powershell
git clone https://github.com/Blackn-L/TuiLens.git
cd TuiLens
npm ci
npm run build
```

系统没有可用的浏览器时再安装：

```powershell
npx playwright install chromium
```

也可以通过 `TUILENS_BROWSER_PATH` 明确指定浏览器路径。

配置 MCP 客户端前，在仓库根目录运行一次 launch/observe/close 冒烟测试：

```powershell
node .\dist\src\interfaces\cli.js launch --cols 80 --rows 16 -- node .\examples\echo-tui.mjs
node .\dist\src\interfaces\cli.js observe <会话 ID>
node .\dist\src\interfaces\cli.js close <会话 ID>
```

把 `<会话 ID>` 替换为 `launch` 返回的 `data.id`。`observe` 应返回包含 `READY` 的画面和 PNG
路径。先解决构建或浏览器问题，再排查 MCP 连接。

## 配置客户端

使用构建后 CLI 的绝对路径，并把 `mcp` 作为第一个参数。不要把客户端指向目录，也不要指向
源码 `.ts` 文件。

### Codex

Windows 编辑 `%USERPROFILE%\.codex\config.toml`，Linux 编辑 `~/.codex/config.toml`：

```toml
[mcp_servers.tuilens]
command = "node"
args = ['C:\Users\<用户名>\TuiLens\dist\src\interfaces\cli.js', "mcp"]
```

Linux 示例：

```toml
[mcp_servers.tuilens]
command = "node"
args = ["/home/<用户名>/TuiLens/dist/src/interfaces/cli.js", "mcp"]
```

如果 GUI 客户端找不到 `node`，先查询它的绝对路径：

```powershell
(Get-Command node).Source
```

然后把该路径填入 `command`。

### 其他 MCP 客户端

如果客户端使用常见的 `mcpServers` JSON 配置：

```json
{
  "mcpServers": {
    "tuilens": {
      "command": "node",
      "args": [
        "C:\\Users\\<用户名>\\TuiLens\\dist\\src\\interfaces\\cli.js",
        "mcp"
      ]
    }
  }
}
```

不同客户端的配置文件和重启方式不同，但 `command` 与 `args` 保持一致。如果客户端支持环境变量，
可以通过 `TUILENS_BROWSER_PATH` 指定浏览器可执行文件。

## 验证接入

重启客户端后，应能看到 `terminal_launch`、`terminal_observe`、`terminal_find`、
`terminal_input`、`terminal_inputAndWait`、`terminal_wait`、`terminal_clickText`、
`terminal_compare`、`terminal_replay`、`terminal_scenario`、`terminal_perf` 和
`terminal_close` 等工具。

最小验收步骤：

1. 调用 `terminal_launch`，使用示例 TUI 的绝对路径：

   ```json
   {
     "command": "node",
     "args": ["C:\\Users\\<用户名>\\TuiLens\\examples\\echo-tui.mjs"],
     "cols": 80,
     "rows": 16
   }
   ```

2. 保存返回的 `id`。
3. 用 `{"id":"<会话 ID>"}` 调用 `terminal_observe`。
4. 用同一个 ID 调用 `terminal_close`。

支持 MCP 图片内容的客户端会收到 PNG 截图和文字元数据；不支持图片渲染的客户端仍可使用终端文字
和快照元数据。

## 常见问题

| 现象 | 可能原因 | 处理方式 |
| --- | --- | --- |
| `Cannot find module .../cli.js` | 只下载了项目但没有构建，或路径错误 | 执行 `npm run build`，并使用 `dist/src/interfaces/cli.js` 的绝对路径 |
| `spawn node ENOENT` | MCP 客户端没有继承 shell 的 `PATH` | 把 `command` 改成 `node` 可执行文件的绝对路径 |
| 重启后看不到工具 | 客户端没有重新加载配置，或服务启动失败 | 查看客户端的 MCP 日志，核对路径，然后重启客户端 |
| `node-pty` 安装失败 | Node 版本不满足要求，或缺少原生构建工具 | 使用 Node.js 22+，执行 `npm ci`；必要时安装平台 C++ 工具链 |
| 浏览器启动失败 | 没有检测到 Chrome/Edge | 执行 `npx playwright install chromium`，或设置 `TUILENS_BROWSER_PATH` |
| 相对路径的文件或命令找不到 | 客户端的工作目录与 shell 不同 | 在工具参数中传入绝对 `cwd`、程序路径或脚本路径 |
| 直接运行 `mcp` 命令后一直没有输出 | stdio 服务正在等待 JSON-RPC 输入，这是正常行为 | 通过 MCP 客户端测试，不要把它当成交互式终端命令 |
| 工具失败后仍有会话进程 | 没有显式关闭会话 | 调用 `terminal_close`；MCP 连接断开时也会回收该连接创建的会话 |

## 安全与远程使用

MCP 服务可以用当前用户权限启动任意本地程序。只安装可信的代码副本，并在运行场景前检查其内容。

传输只在本机进行：Windows 使用命名管道，Linux 使用 abstract Unix socket，并通过本地令牌认证。
没有公开的 HTTP/SSE 控制端点。每个使用者应各自安装一份 TuiLens，不要把本地守护进程 socket
暴露给其他机器。

工具与 CLI 参数格式见[协议示例](PROTOCOL.md)。
