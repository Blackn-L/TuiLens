# TuiLens

面向 AI Agent 的可观察、可操作终端运行环境。当前为 `0.1.0` 功能原型。

TuiLens 启动真实程序，提供终端截图、文本与字符格、键鼠输入、局部等待和生命周期管理。
底层采用 `node-pty + xterm.js + Playwright`，使用 TypeScript/Node.js。

## 启动

要求 Node.js 22+，Windows 或 Linux，以及 Chrome/Chromium。
优先复用系统 Chrome；可通过 `TUILENS_BROWSER_PATH` 指定浏览器。

```powershell
cd TuiLens
npm ci
npm run build
node dist/src/interfaces/cli.js --help
```

没有系统浏览器时，运行 `npx playwright install chromium`。
若安装器提示 `node-pty` 原生构建要求，请使用相应平台的 C++ 构建工具；
实际安装版本锁定在 `package-lock.json`。

启动终端：

```powershell
node dist/src/interfaces/cli.js launch --cols 160 --rows 50 -- powershell.exe -NoLogo -NoProfile
```

输出 JSON 中的 `data.id` 是会话 ID。后续命令在同一本机服务中操作它：

```powershell
node dist/src/interfaces/cli.js type <id> "Write-Output 'Hello TuiLens'"
node dist/src/interfaces/cli.js key <id> Enter
node dist/src/interfaces/cli.js wait <id> --text "Hello TuiLens"
node dist/src/interfaces/cli.js observe <id>
node dist/src/interfaces/cli.js close <id>
node dist/src/interfaces/cli.js shutdown
```

Linux 启动示例：`node dist/src/interfaces/cli.js launch -- bash --noprofile --norc`。
如果输出中已有输入回显，不能仅凭 `wait --text` 判断命令已执行；实际场景应使用专用结果标记或限定区域。

首次命令自动启动后台本机 IPC 服务。`close` 释放一个会话，`shutdown` 释放全部会话并停止服务。
默认数据在 `~/.tuilens/`，可用 `TUILENS_HOME` 隔离不同测试任务。
没有公网 HTTP 控制端口；Windows 使用命名管道，Linux 使用 abstract Unix socket。

## 观察与操作

| 命令 | 行为 |
| --- | --- |
| `list` | 会话、PID、尺寸与退出状态 |
| `observe <id>` | 同一次观察的文字与 PNG 路径；自动保存 PNG 和完整 JSON |
| `observe <id> --cells` | 额外返回完整字符格；默认省略以减小 Agent 上下文 |
| `observe <id> --no-screenshot` | 只读状态，仍有字符格读取成本 |
| `find <id> 文本 --region x,y,w,h` | 按字符格定位中文、emoji 与组合字素 |
| `type / paste / key` | 文本、协商后的括号粘贴、按键 |
| `click <id> x y` | 在指定字符格点击 |
| `scroll <id> x y down 3` | 对指定位置发送滚轮 |
| `resize <id> cols rows` | 修改 PTY 和模拟器尺寸 |
| `wait <id> --text 文本 --region x,y,w,h` | 等待区域包含文字 |
| `wait <id> --stable 250 --region x,y,w,h` | 等待区域文字与样式保持稳定 |
| `metrics <id>` | 接收/应用字节、排队峰值、背压次数与时长 |

所有坐标从 **0** 起算，单位为字符格。窗口范围：2–500 列、2–250 行。
`find` 只能发现显示文字，不知道它是否为业务按钮。
鼠标首版要求应用开启字符格 SGR 编码（1006）；对 legacy 和像素 SGR 明确报错。

复杂参数支持 `--json`、`--file` 或 `--stdin`，三者选择一个：

```json
{
  "id": "实际会话 UUID",
  "conditions": [
    { "kind": "size", "cols": 200, "rows": 60 },
    {
      "kind": "text",
      "text": "退出",
      "region": { "x": 0, "y": 57, "width": 200, "height": 3 }
    }
  ],
  "timeoutMs": 10000
}
```

保存为文件后调用 `node dist/src/interfaces/cli.js wait --file wait.json`。
组合条件为 AND。resize 返回只表示尺寸已送达，应用完成重排应由布局条件证明。
超时返回 `WAIT_TIMEOUT`，附带当前截图路径或证据采集失败原因。

## MCP 与 SDK

MCP stdio 启动命令：

```text
node /path/to/TuiLens/dist/src/interfaces/cli.js mcp
```

工具包括 `terminal_launch`、`terminal_list`、`terminal_observe`、`terminal_find`、
`terminal_input`、`terminal_resize`、`terminal_wait`、`terminal_metrics`、`terminal_close`。
`terminal_observe` 同时返回文字状态和 PNG image content。
断开 MCP 时只释放该连接创建的会话；CLI 创建的会话需显式关闭。

SDK：

```typescript
import { SessionManager } from "./dist/src/index.js";

const manager = new SessionManager({ artifactDir: "./artifacts" });
try {
  const session = await manager.launch({
    command: "bash",
    args: ["--noprofile", "--norc"],
    cols: 160,
    rows: 50,
  });
  await manager.input(session.id, { type: "text", text: "printf 'READY\\n'" });
  await manager.input(session.id, { type: "key", key: "Enter" });
  const observation = await manager.observe(session.id);
  console.log(observation.screenshot?.path);
} finally {
  await manager.closeAll();
}
```

## 架构与迭代

见 [架构](docs/ARCHITECTURE.md)、[性能边界](docs/PERFORMANCE.md)、
[验证记录](docs/VALIDATION.md) 和 [后续迭代](docs/ROADMAP.md)。

依赖方向：`interfaces → transport → session → core/engine`。
CLI 和 MCP 共享同一服务接口。`TerminalEngine` 可替换；
核心等待、坐标与错误契约不依赖具体终端实现。
引入原生处理引擎或 Rust 进程时，应实现相同协议并复用验收，不在接口层复制状态机。

关键保障：

- PTY 输出有界合批；达到高水位暂停读取，并公开背压指标。
- 观察屏障中冻结新输出应用，字符快照与 PNG 使用相同 `frameId`。
- 同步输出未提交时返回内部 `FRAME_PENDING`，释放队列后有界重试。
- 输入只读轻量模式，不先遍历整屏字符格。
- 支持取消、迟到启动清理、退出后的最后一帧和显式资源释放。

## 验证与当前限制

```text
npm run check
npm test
npm run benchmark:overhead -- --frames 120 --repeats 3 --pace-ms 1
```

首版是**功能与视觉验证工具**，不是零开销性能探针：

- 尚未验证数小时长任务、进程树资源增长或严格输入延迟基准。
- Chromium 的 CPU/RSS 不包含在当前基准的“工具根进程”指标里。
- 首版支持文字与字符块；kitty/sixel、系统输入法候选窗和系统剪贴板尚未覆盖。
- 终端截图只代表固定模拟器与字体环境，不替代各终端宿主的真机验收。
- Windows `node-pty 1.1.0` 在自然退出后的资源回收中可能输出 `AttachConsole failed`。
  本次已验证最终释放；它发生在清理辅助进程中，原始诊断未隐藏。
- 原始输出录制/回放、多宿主语义对照、任务级性能隔离属于后续迭代。

运行数据与截图可能包含终端正文，默认保存在本地并被 Git 忽略。
依赖版本固定在锁文件中；发布前应在目标平台执行检查。
