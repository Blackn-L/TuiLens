# Changelog

## Unreleased

### Performance
- **Snapshot transport rewritten.** Character grids are packed into two strings inside the browser and unpacked in Node. A 160×50 `observe` dropped from ~770 ms to ~4 ms; `find` from ~940 ms to ~5 ms.
- `observe`/`snapshot` accept `cells:false`; `find`, `wait`, `compare`, `inputAndWait` and `timeoutEvidence` skip the grid when they do not need it. `observe` over CLI/MCP now builds the grid only when `includeCells` is requested.
- Wait polling uses adaptive backoff (2 ms → 50 ms) instead of a fixed 50 ms tick, so `wait` and `perf` measurements are no longer quantized by the poll interval. Timeouts are now honored (~1.1 s for a 1 s timeout, previously ~2 s).

### Added
- Terminal capability profiles: built-in `kitty`, `wezterm`, `iterm2`, `windows-terminal`, `alacritty`, `vscode`, `tmux`, `xterm-256color` and `linux` presets; JSON `extends` derivatives; `--terminal-profile`; orthogonal `graphics`; profile-driven environment, replies, image protocols, keyboard capability query and scrollback.
- Scenario and performance `profiles: [...]` matrices, with per-profile reports and a perf comparison table. The default remains `xterm-256color`.
- `perf` command/MCP tool/SDK API: declarative performance scenarios with warmup rounds, per-round process restarts, `{{seq}}` evidence templates, setup history growth, process-tree RSS sampling, baseline files and threshold-based regression gating.
- Testing assertion layer (`terminal()`, `Terminal#expectText/expectNoText/expectCursor/expectSize`) with expected/actual/screenshot on failure.
- JUnit XML output (`--junit`) for scenarios and performance runs; CI uploads evidence artifacts and runs a report-only perf smoke on pull requests.
- `observe.scrollback` reads viewport-above history lines (text only) so scrolled-away content can be asserted.
- Kitty keyboard protocol (`CSI u`) and xterm `modifyOtherKeys` detection and encoding: `Shift+Enter`, `Ctrl+Enter`, `Ctrl+Space`, `Shift+Tab` and modified function keys are now expressible. Ctrl+letter keeps its traditional C0 byte under `modifyOtherKeys`.
- `TerminalModes.keyboard` exposes negotiated keyboard protocol state.
- `ManagerOptions.maxSessions` and `TUILENS_MAX_SESSIONS`; sessions now share one Chromium process via a reference-counted host.
- `errorRecord` returns `messageEn` from a stable error-code catalog.
- `LICENSE` (MIT) and `package.json` `files`/`license`/`repository` metadata.

### Changed
- `images` is deprecated and internally maps to `capabilities.graphics`. DA1 feature `4` follows the resolved SIXEL capability.
- Windows sessions that explicitly select a profile use the bundled node-pty ConPTY DLL so DA1/DA2 queries reach the emulator, with a bounded conout worker cleanup and a final profile-aware reply rewrite. The default fast path keeps system ConPTY.
- Silenced node-pty's Windows console-list helper when `AttachConsole` fails during cleanup and made it fall back immediately instead of printing a stack trace and waiting for the 5 s timeout.
- Wheel `to:"top"/"bottom"` is written to the PTY in 20 batches of 100 events with event-loop yields, so long scrolls are cancellable and do not burst the application.
- `createBrowserEngine` still owns an isolated browser; `SessionManager` uses a shared host by default.

- Added explicit pending-frame `clickText` targeting with unchanged region guards.
- Added page-unit wheel scrolling and bounded top/bottom navigation across SDK, CLI and MCP.
- Preserved unrelated input under `protocolReplies:"suppress"` and improved invalid `colorMode` diagnostics.
- Added real PTY pending-click and MCP `colorMode:"truecolor"` regression coverage.

## 0.4.0

- Added delayed terminal-reply filtering, `protocolReplies` launch policy and protocol reply metrics.
- Added `clickText` hitbox/point/offset targeting and mouse button/modifier support.
- Added `inputAndWait` across SDK, CLI and MCP with text, size, stable, exit and cursor conditions.
- Added cursor visibility/style/blink metadata and default hidden cursors in screenshots.
- Added forced repaint and grid-geometry validation before capture to reduce stale resize PNGs.
- Added Windows `PATH`/`PATHEXT` executable resolution for bare commands such as `ssh`.
- Fixed `click-text --json` and `input-wait --json` method aliases.

## 0.3.0

- Added the `iterm` image profile and OSC 1337 inline images in `all`.
- Added optional-size normalization, multipart transfers, aspect-ratio fitting, and bounded image validation.
- Added image capture, malformed-input recovery, PTY and replay regressions for the new profile.

## 0.2.0

- Added opt-in SIXEL and bounded inline Kitty graphics, including Unicode virtual placements.
- Added region captures, PNG comparisons, masks, diff files and read-only baselines.
- Added mouse down/up, drag and modifiers.
- Added output recording, bounded offline replay, and declarative scenario reports.
- Added style/unique/nth targeting, frame/region input guards and fresh-frame waits.
- Added cancellation, recording-integrity, bounded-file and image-resource regression coverage.
- Added English-first documentation with Simplified Chinese translations.

## 0.1.0

- Initial PTY, browser engine, CLI, MCP, SDK, observation and input support.

## 简体中文

未发布：新增终端能力画像与 9 个内置 preset，支持 JSON `extends` 派生、`--terminal-profile`、
正交 `graphics` 和 profile 驱动的环境/应答/图片/键盘查询/回滚缓冲；场景与性能测试支持
`profiles: [...]` 矩阵并输出 profile 维度对比表。`images` 标记为弃用并映射到 `capabilities.graphics`。
Windows 显式选择 profile 时使用随包 ConPTY DLL，并在应答进入 PTY 前按 profile 做最终改写；
未显式选择 profile 的默认路径继续使用系统 ConPTY。另新增未提交帧的显式 clickText 定位
（保留区域指纹）、按页和首尾滚动导航；
suppress 不再吞掉无关输入，非法 colorMode 诊断包含收到的值，并补充真实 PTY 与 MCP 回归。
Windows 清理阶段的 node-pty 辅助进程在 `AttachConsole` 失败时不再输出告警，并立即回退，
不再空等 5 秒超时。

0.4.0：新增迟到终端应答过滤与策略、clickText 命中区、inputAndWait、光标元数据与截图默认隐藏光标、
截图强制重绘和 resize 网格校验、Windows 裸命令 PATH/PATHEXT 解析，并修复 JSON 命令别名。

0.3.0：新增 iterm 图片档与 OSC 1337 内联图片，支持分段传输、可选尺寸字段、
宽高比例适配和有界校验；补充截图、异常恢复、PTY 和回放回归。

0.2.0：新增原生图片子集、区域截图与视觉比较、拖拽和修饰键、录制回放与场景、样式定位与过期保护；
补充取消/完整性/容量回归，以及默认英文和中文对应文档。

0.1.0：初始 PTY、浏览器引擎、CLI、MCP、SDK、观察与输入支持。
