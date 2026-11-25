# Changelog

## 0.6.0

### Added
- Scenario, performance and recording outputs now share a versioned Evidence Bundle with explicit
  artifact roles for screenshots, failure evidence, compare images, baselines and recordings.
- `scenario --html` and `perf --html` render zero-dependency single-file HTML reports with timelines,
  compare sliders, SVG charts, matrix tabs and bounded image inlining. `tuilens report` renders an
  existing JSON result or JSONL recording offline.
- HTML reports escape dynamic text and script JSON, inline at most 8 MiB per image and 24 MiB total,
  bound recording replay text to 2 MiB, and expose the Evidence Manifest as embedded JSON.
- SDK exports the three HTML renderers, Evidence Bundle types/builders, image budgets and the bounded
  recording parser.
- MCP v2 exposes bounded `tuilens://` resources for sessions, compact screens, PNG screenshots,
  metrics and artifacts, plus `tui_reproduce_bug` and `tui_visual_regression` prompts.
- `tuilens mcp-config` generates JSON, Codex TOML and Claude Code commands for global, npx and
  absolute executable modes.

### Changed
- Text sessions now use a browser-free `@xterm/headless` terminal core by default.
  Chromium and the xterm.js DOM/WebGL surface load lazily for explicit renderers, image protocols,
  screenshots and visual comparisons.
- `renderer` now reports `headless`, `dom` or `webgl` from live session state; `visualSyncDegraded`
  marks a truncated 4 MiB visual replay when the browser layer attaches late.
- `benchmark:overhead` accepts `--renderers headless,dom,webgl` for startup and RSS comparisons.
- Recording headers move to version 2 with the renderer captured at recording start; the legacy
  image-mode field and its replay mapping are gone.
- Local IPC now uses persistent v2 NDJSON connections with one-time authentication, multiplexed
  requests, per-id cancellation, bounded in-flight requests and server-pushed `watch` frames.
- `scenario` and `perf` emit real progress events, and the CLI `watch` consumes daemon events instead
  of polling `observe`.
- MCP forwards real daemon progress for `wait`, `inputAndWait`, `replay`, `scenario` and `perf`;
  timed heartbeats are removed.
- MCP instructions and tool descriptions document the compact -> inputAndWait -> diff observation
  loop and keep screenshots explicit.
- `observe` now uses `view: "compact" | "full" | "cells" | "diff"`. `diff` requires `fromFrameId`,
  returns changed lines plus a wide-character-aware bounding region, and falls back to compact text
  after the 16-frame lightweight history is exhausted.
- Screenshots are opt-in with `screenshot:true` for every observation view.
- Performance results retain a bounded RSS timeline for reporting; scenario steps record a human-readable
  action/condition detail plus grid dimensions.

### Fixed
- Visual replay now rebases its initial grid when evicted resize events are no longer available, and
  releases the replay buffer after the visual renderer attaches.
- `watch` retries after `FRAME_PENDING` instead of waiting for an unrelated frame notification.
- IPC preserves real socket errors such as `EACCES` instead of masking them as an unavailable daemon.
- `shutdown` flushes its response before stopping the daemon, with a bounded fallback timeout.
- Diff regions now extend through a shared suffix when a per-line insertion or deletion changes the
  display width, so callers can crop or compare every shifted cell.
- `observe` with `view:"diff"` keeps explicitly requested scrollback on a cache hit while still
  omitting viewport text and cells.
- `mcp-config` invalid client/mode errors now expose the specific English message instead of placing it
  in `details`.

### Removed
- Removed the per-request short IPC connection protocol.
- Removed `observe.compact`, `includeCells`, CLI `--compact`, `--cells` and `--no-screenshot`.
- Removed `launch.images`, CLI `--images`, `ImageProfile` and `imageProfileGraphics`.
  Use `terminalProfile` capabilities or orthogonal `graphics` options.
- Removed MCP progress heartbeats.

## 0.5.5

### Fixed
- macOS performance runs now sample the real process tree through `ps`; `peakRssBytes` and
  `peakProcesses` no longer collapse to zero.
- Multi-condition waits retry `FRAME_PENDING`, advance backoff once per poll, and perform a final
  check after a deadline-truncated sleep.
- `Terminal.expectNoText()` now honors region column bounds and style filters; assertion failure
  screenshots use the same 5 second lower bound as other evidence captures.
- Concurrent `launch()` calls prepare engines in parallel while pending launches retain their slot;
  the admission lock is released after the pending launch is registered.
- `watch --control` serializes forwarded input so fast keystrokes cannot overtake each other, and
  `watch` exits after the monitored session has exited.
- Performance reports retain process-tree sampling `errors`, `lastError` and `peakRootRssBytes`
  instead of silently reducing failures to zero.
- Scenario observation and failure evidence skip character grids and use a 5 second evidence timeout.
- IPC treats `SHUTTING_DOWN` as recoverable during auto-start, and startup-lock rollback verifies the
  created file identity before unlinking.
- Browser host disposal waits for an in-flight launch before deciding whether to close the browser.
- Local IPC removes the per-request preflight ping, uses an owner-token autostart lock, cleans stale
  macOS sockets after an inode-checked bind failure, and uses constant-time token comparison.
- Replay participates in the same admission and exited-session reclamation path as launch.

### Changed
- Replaced the full `playwright` package with `playwright-core`; Chromium remains an explicit runtime
  prerequisite installed with `npx playwright-core install chromium`.
- Stable dependencies use SemVer ranges. `node-pty` moves to `1.2.0-beta.18` and remains the only exact
  prerelease pin until a stable compatibility release can replace it.
- `src/version.ts` is generated from `package.json`; mismatch checks run in the quality gate.
- Timeout evidence screenshots now use the same 5 second lower bound as confirmed-input screenshots.
- Dispatcher params are validated once; process-tree lookup uses pid/parent maps.
- Clean-install smoke now runs `doctor` and verifies browser/PTY/storage module loading, not only
  package version and CLI entry.

### Added
- Tag-driven npm publish/provenance, GitHub Release, version/tag validation and clean-install smoke
  workflows.
- Biome lint and formatting gates, coverage thresholds, scheduled soak runs, dependency drift artifacts
  and Dependabot updates.
- Release documentation and explicit renderer/image-protocol boundaries with replacement criteria.

## 0.5.0

### Performance
- **Snapshot transport rewritten.** Character grids are packed into two strings inside the browser and unpacked in Node. A 160×50 `observe` dropped from ~770 ms to ~4 ms; `find` from ~940 ms to ~5 ms.
- `observe`/`snapshot` accept `cells:false`; `find`, `wait`, `compare`, `inputAndWait` and `timeoutEvidence` skip the grid when they do not need it. `observe` over CLI/MCP now builds the grid only when `includeCells` is requested.
- Wait polling uses adaptive backoff (2 ms → 50 ms) instead of a fixed 50 ms tick, so `wait` and `perf` measurements are no longer quantized by the poll interval. Timeouts are now honored (~1.1 s for a 1 s timeout, previously ~2 s).

### Added
- `doctor` command for local runtime, browser, `node-pty`, storage and daemon diagnostics without starting the daemon.
- `ping` now reports daemon uptime plus live session, launch and replay counts; `shutdown` is idempotent when no daemon is running.
- `observe --compact` trims line ends, omits cells and defaults to no screenshot; `watch` streams changed frames as JSONL and supports explicit `--control` TTY handoff.
- Engine-side `probeText` evaluates regional text/style matches without transferring the full character grid before a match.
- MCP long-running calls emit progress heartbeats when requested; cancellation aborts the matching daemon operation.
- Optional `TUILENS_PTY_WORKER=1` / `ManagerOptions.ptyWorker` isolates `node-pty` in a per-session child process.
- `probe` reports fixed-glyph widths plus renderer/font/grid metadata and a stable fingerprint; snapshots expose `render`.
- Screenshot font pinning via `TUILENS_FONT_FILE`/`ManagerOptions.fontFile`, with a font hash in `render`;
  the default renderer injects circled-numeral-only local fallbacks, and `probe --strict-font` detects
  inconsistent circled-numeral glyph scale.
- `paint()` and `snapshot.render.paintMs` expose frame-level paint timing; `npm run soak` provides a bounded soak check.
- The macOS runner joins the CI matrix as an experimental platform.
- Optional WebGL renderer (`launch --renderer webgl`) on top of xterm.js, with DOM as the default.
  The actual renderer is returned in sessions and recorded in recording headers, scenario/perf environments,
  observation metadata and visual comparison JSON. WebGL failure falls back to DOM and reports the actual value.
- Regression coverage for 120 block glyphs: WebGL must not reintroduce periodic 9/10px dark columns.
- English-default localization for CLI help, MCP tool descriptions, errors and assertion messages;
  set `TUILENS_LANG=zh-CN` for Simplified Chinese. Structured errors retain both `messageEn` and `messageZh`.
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
- Daemon shutdown handles `SIGBREAK` on Windows and `SIGHUP` on POSIX in addition to `SIGINT`/`SIGTERM`.
- CI now covers Node.js 22 and 24 on Windows, Linux and macOS.
- Pinned `node-pty@1.2.0-beta.14`: 1.1.0 ships a non-executable macOS `spawn-helper` and leaks file descriptors across repeated PTY spawns, which prevents the macOS CI job from launching any PTY.
- `images` is deprecated and internally maps to `capabilities.graphics`. DA1 feature `4` follows the resolved SIXEL capability.
- Windows sessions that explicitly select a profile use the bundled node-pty ConPTY DLL so DA1/DA2 queries reach the emulator, with a bounded conout worker cleanup and a final profile-aware reply rewrite. The default fast path keeps system ConPTY.
- Silenced node-pty's Windows console-list helper when `AttachConsole` fails during cleanup and made it fall back immediately instead of printing a stack trace and waiting for the 5 s timeout.
- Wheel `to:"top"/"bottom"` is written to the PTY in 20 batches of 100 events with event-loop yields, so long scrolls are cancellable and do not burst the application.
- `createBrowserEngine` still owns an isolated browser; `SessionManager` uses a shared host by default.
- Launch admission reclaims the oldest exited sessions when the session budget is full; running sessions still return `SESSION_LIMIT`.

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

0.6.0：完成 TerminalCore/VisualRenderer 分层、持久化 IPC v2、声明式观察与增量 diff、
Agent 原生 MCP v2 与统一 Evidence Bundle。新增零外部依赖单文件 HTML 报告、`scenario/perf --html`、
`tuilens report`、三类报告 SDK 导出与 CI 证据归档；单图内联上限 8 MiB、总计 24 MiB，
动态文本与内嵌 JSON 均安全转义。版本升级至 0.6.0，npm 发布保持手动安排。

0.5.5：修复 macOS 进程树采样、组合等待 `FRAME_PENDING`/退避/末次检查、浏览器宿主 dispose 竞态、
本机 IPC 自动启动竞态、macOS 残留 socket 和回放槽位回收；`playwright` 替换为 `playwright-core`，
稳定依赖改用 SemVer 范围，`node-pty` 更新至 `1.2.0-beta.18`。版本号从 `package.json` 生成，
新增 Biome/格式/覆盖率门禁、定时 soak、依赖漂移归档、tag 驱动的 npm publish/GitHub Release、
干净安装烟测和发布文档，并记录浏览器引擎与图片协议边界。

0.5.0：新增 `doctor` 本地诊断命令，检查运行时、浏览器、`node-pty`、存储和 daemon 状态但不启动 daemon；
`ping` 返回 daemon 运行时长和会话/启动/回放计数，未运行 daemon 时 `shutdown` 可幂等成功。
新增 compact 观察、watch/control、引擎侧区域 probeText、MCP 进度与取消、可选 PTY worker、
固定字形 probe、render/paint 元数据、soak 脚本；CI 覆盖 Windows/Linux/macOS 上的 Node.js 22 与 24。
截图字体可用 `TUILENS_FONT_FILE`/`ManagerOptions.fontFile` 固定，并在 `render` 中记录字体哈希；
默认渲染注入只覆盖圈码的本地 fallback，`probe --strict-font` 会检查圈码字阶。
新增可选 WebGL renderer（默认 DOM），session、录制、scenario/perf、观察和视觉比较元数据
记录实际 renderer；WebGL 不可用时回退并回传 DOM。增加 120 个块字符的周期暗列回归测试。
新增终端能力画像与 9 个内置 preset，支持 JSON `extends` 派生、`--terminal-profile`、
正交 `graphics` 和 profile 驱动的环境/应答/图片/键盘查询/回滚缓冲；场景与性能测试支持
`profiles: [...]` 矩阵并输出 profile 维度对比表。`images` 标记为弃用并映射到 `capabilities.graphics`。
Windows 显式选择 profile 时使用随包 ConPTY DLL，并在应答进入 PTY 前按 profile 做最终改写；
未显式选择 profile 的默认路径继续使用系统 ConPTY。另新增未提交帧的显式 clickText 定位
（保留区域指纹）、按页和首尾滚动导航；
suppress 不再吞掉无关输入，非法 colorMode 诊断包含收到的值，并补充真实 PTY 与 MCP 回归。
Windows 清理阶段的 node-pty 辅助进程在 `AttachConsole` 失败时不再输出告警，并立即回退，
不再空等 5 秒超时。node-pty 固定到 `1.2.0-beta.14`：1.1.0 的 macOS npm 包缺少
`spawn-helper` 执行位，并在反复启动 PTY 时泄漏文件描述符。
会话额度满时，新启动会先回收最旧的已退出会话，运行中的会话不会被自动关闭。

0.4.0：新增迟到终端应答过滤与策略、clickText 命中区、inputAndWait、光标元数据与截图默认隐藏光标、
截图强制重绘和 resize 网格校验、Windows 裸命令 PATH/PATHEXT 解析，并修复 JSON 命令别名。

0.3.0：新增 iterm 图片档与 OSC 1337 内联图片，支持分段传输、可选尺寸字段、
宽高比例适配和有界校验；补充截图、异常恢复、PTY 和回放回归。

0.2.0：新增原生图片子集、区域截图与视觉比较、拖拽和修饰键、录制回放与场景、样式定位与过期保护；
补充取消/完整性/容量回归，以及默认英文和中文对应文档。

0.1.0：初始 PTY、浏览器引擎、CLI、MCP、SDK、观察与输入支持。
