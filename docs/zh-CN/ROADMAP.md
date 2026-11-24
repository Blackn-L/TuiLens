# 后续迭代

[English](../ROADMAP.md) · [简体中文](ROADMAP.md)

首版优先完成可用协议与真实验收。每项迭代应保留现有行为测试和终端真实样本。

## 0.2 已实现

SIXEL/Kitty 内联图片子集、区域截图与视觉比较、拖拽和修饰键、有界录制回放、
声明式场景、样式/唯一/nth 定位，以及帧/区域保护。

0.3 新增 iTerm2 OSC 1337 内联图片和分段传输。

0.4 新增终端应答时延护栏、inputAndWait、点击命中区、光标元数据、截图光标隐藏、
渲染稳定校验和 Windows 裸命令解析。

0.5 新增本地 `doctor` 诊断、daemon 计数与幂等关闭，并继续收口观察和测试接口。

## 0.5.x 计划

0.5.1–0.5.4 已落地；当前补丁版本为 0.5.5，用于补齐发布链路和质量门禁，不再延后。

### 0.5.0 交付基础（已落地）

- 新增 `doctor`，检查运行时、浏览器、`node-pty`、存储和 daemon。
- `ping` 返回 daemon 运行时长，以及活动会话、启动中和回放计数。
- `shutdown` 支持幂等成功；Windows 处理 `SIGBREAK`，POSIX 处理 `SIGHUP`。
- 陈旧 daemon 元数据只报告，不自动删除。
- CI 覆盖 Windows/Linux 上的 Node.js 22 与 24。

退出条件：Windows 和 Linux 的诊断与生命周期检查通过，不依赖发布链路。

### 0.5.1 Agent 紧凑观察（已落地）

- 增加面向 Agent 的紧凑屏幕视图，包含文本、光标、帧和区域摘要。
- 把区域文本、样式和稳定判断下移到引擎侧。
- 不需要完整字符格时，只返回匹配证据和区域指纹。

退出条件：代表性 read/wait 循环减少传输量，同时保持现有语义。

### 0.5.2 MCP 长任务与 PTY 隔离（已落地）

- 为 wait、scenario 和 perf 增加 MCP 进度与取消覆盖。
- 隔离 PTY worker，缩小原生模块异常和清理问题的影响范围。
- 增加崩溃与恢复测试，验证会话归属和资源回收。

退出条件：长等待可取消；单个 PTY 故障不影响无关会话。

### 0.5.3 跨平台与渲染保真（已落地）

- macOS 以实验性平台进入 CI。
- 增加字体指纹、歧义宽度和缺字探测。
- 用固定样本比较 DOM、WebGL 和终端 profile 的差异。

退出条件：受支持平台有 CI 证据，视觉差异可以解释。

### 0.5.4 性能与实时观察（已落地）

- 在条件满足耗时之外增加帧级 paint 时间。
- 为长时会话增加有界 soak 测试。
- 新增只读 `watch` JSONL 观察；`--control` 提供显式 TTY 接管。

退出条件：在考虑原生引擎重写前，先形成可测量的性能预算。

### 0.5.5 发布工程与质量门禁（已落地）

- 将 `playwright` 替换为 `playwright-core`；稳定依赖使用 SemVer 范围，预发布 `node-pty` 继续精确锁定。
- 从 `package.json` 生成 SDK 版本；发布、GitHub Release 和干净安装烟测由 tag 驱动。
- 增加 Biome lint/格式门禁、覆盖率阈值、定时 soak、依赖漂移归档和 Dependabot。
- 明确浏览器渲染器边界，以及替换为原生/无浏览器引擎前必须满足的证据。

退出条件：tag 构建可复现发布、能从打包 tarball 安装，并通过与 CI 相同的检查。

### 0.6.0 PR-1 零浏览器 TerminalCore（已落地）

- 文本观察、等待、探测与快照默认改用 `@xterm/headless`。
- Chromium/xterm.js 视觉层按需加载，用于显式 DOM/WebGL、图片协议、截图与视觉比较；
  懒加载时重放最多 4 MiB 历史并暴露 `visualSyncDegraded`。
- 移除 `launch.images`、CLI `--images`、旧图片简写映射与过时文档。
- `benchmark:overhead` 对照 `headless`、`dom` 与 `webgl` 的启动和 RSS。

退出条件：纯文本会话不启动 Chromium，懒加载截图与后续更新一致，全部质量门禁通过。

### 0.6.0 PR-2 持久化 IPC v2（已落地）

- 用单一鉴权、多路复用的 NDJSON 长连接替换每次请求短连接。
- 支持按请求 ID 取消、单连接最多 64 个在途请求，并移除客户端 watch 轮询。
- 由服务端有界订阅推送 `frame`、`exit` 与真实的 `scenario`/`perf` 进度事件。
- 短命 CLI 调用复用连接，空闲时 `unref()`，确保进程及时退出。

退出条件：v2 是唯一 IPC 协议，watch 与长任务全部使用服务端事件流，取消或关闭后无残留请求与句柄。

### 0.6.0 PR-3 声明式观察与增量 Diff（已落地）

- 用 `view: compact | full | cells | diff` 替换重叠的观察布尔开关。
- 保留 16 帧轻量快照，仅返回变化行和按宽字符显示列计算的包围盒。
- `fromFrameId` 已淘汰时降级为 compact 全文，截图统一改为显式开启。
- 精确样式分析只在 `view:"cells"` 时读取完整字符格。

退出条件：同一观察契约覆盖 Agent 主循环、显式字符格检查和有界增量 Diff，不再每轮返回整屏。

### 0.6.0 PR-4 Agent 原生 MCP v2（已落地）

- wait、inputAndWait、replay、scenario 和 perf 转发真实 daemon 进度，移除假心跳，并写清
  compact -> inputAndWait -> diff 主循环。
- 新增 `tuilens://` 会话、画面、截图、metrics 和 artifact 资源，读取有界并严格限制 artifact
  路径与符号链接。
- 新增中英文缺陷复现/视觉回归 Prompt，以及面向 Codex、Claude Code、Cursor、Gemini CLI
  和通用 JSON 客户端的 `tuilens mcp-config`。
- 把 npm 安装改为首屏接入路径，补充 pnpm 批准 node-pty 的说明，并把浏览器要求限定在视觉功能。

退出条件：长任务上报真实进度，资源和 Prompt 可被发现，路径穿越被拒绝，客户端无需手写绝对路径。

## 后续

- 扩展有测试覆盖的图片协议语义，不宣称未实现能力。
- 图片解码与像素截图继续使用浏览器路径，同时验证解析/状态等价性。
- 完全无浏览器的视觉后端仍需可复现的像素、字体和图片协议等价证据。
  边界见[架构](ARCHITECTURE.md)。
