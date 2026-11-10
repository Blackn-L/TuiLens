# Changelog

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

0.4.0：新增迟到终端应答过滤与策略、clickText 命中区、inputAndWait、光标元数据与截图默认隐藏光标、
截图强制重绘和 resize 网格校验、Windows 裸命令 PATH/PATHEXT 解析，并修复 JSON 命令别名。

0.3.0：新增 iterm 图片档与 OSC 1337 内联图片，支持分段传输、可选尺寸字段、
宽高比例适配和有界校验；补充截图、异常恢复、PTY 和回放回归。

0.2.0：新增原生图片子集、区域截图与视觉比较、拖拽和修饰键、录制回放与场景、样式定位与过期保护；
补充取消/完整性/容量回归，以及默认英文和中文对应文档。

0.1.0：初始 PTY、浏览器引擎、CLI、MCP、SDK、观察与输入支持。
