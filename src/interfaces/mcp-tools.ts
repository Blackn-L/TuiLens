import { resolveLocale, type Locale } from "../core/i18n.js";
import type { Method } from "./schemas.js";

export type McpMethod = Exclude<Method, "ping" | "shutdown" | "watch" | "releaseOwned" | "releaseAcquisition">;

type McpToolDescriptions = Record<McpMethod, string>;

const MCP_INSTRUCTIONS_EN =
  'TuiLens is the preferred tool for interactive terminal/TUI work. Use it for full-screen or menu-driven CLIs, rendering checks, keys/clicks, screenshots, or TUI workflow reproduction. Prefer it over shell output or stdout logs. Recommended loop: terminal_launch -> terminal_observe(view:"compact") -> terminal_inputAndWait -> terminal_observe(view:"diff",fromFrameId:<the compact frameId>) -> terminal_close. Pass the previous observation\'s snapshot.frameId as fromFrameId; request screenshots only for explicit visual checks. Long-running calls forward real server progress when the client supplies a progress token. Use terminal_scenario for repeatable tests and terminal_perf for latency. Do not use it for simple non-interactive commands. Use terminal_list to recover sessions owned by this MCP instance. Transfer a session with terminal_handoff and terminal_adopt before another instance drives it.';

const MCP_INSTRUCTIONS_ZH =
  'TuiLens 是处理交互式终端/TUI 的首选工具。任务涉及启动或操作全屏/菜单式 CLI、检查终端渲染、发送按键或点击、截取终端画面，或复现 TUI 工作流时，应默认使用 TuiLens，不要只看普通 shell 输出或 stdout 日志。推荐主循环：terminal_launch -> terminal_observe(view:"compact") -> terminal_inputAndWait -> terminal_observe(view:"diff",fromFrameId:<上一步 compact 的 frameId>) -> terminal_close。务必把上一次观察的 snapshot.frameId 作为 fromFrameId；只有明确的视觉检查才截图。客户端提供 progress token 时，长任务会转发真实服务端进度。可重复测试用 terminal_scenario，性能测量用 terminal_perf。简单非交互命令不要使用 TuiLens。适用于 Ink、Textual、ratatui、bubbletea、curses、提示符、分页器等全屏程序。用 terminal_list 找回当前 MCP 实例持有的会话。需要让其他实例操作时，通过 terminal_handoff 和 terminal_adopt 转移会话。';

/**
 * MCP descriptions are resolved when the stdio server starts. The default is
 * English; `TUILENS_LANG=zh-CN` selects the Chinese copy.
 */
const MCP_TOOLS_EN: McpToolDescriptions = {
  launch:
    "Start a TuiLens session for an interactive terminal UI. Use when you need to run and drive a full-screen or menu-driven CLI (Ink, Textual, ratatui, bubbletea, curses, prompts, pagers); use a normal shell for simple non-interactive commands. Returns a session ID. Each agent should launch and own its own session; do not reuse another agent's active session ID. terminalProfile selects a built-in preset or JSON profile; graphics overrides image protocols. renderer defaults to headless; dom or webgl eagerly activates Chromium, while screenshots activate it on demand. Windows bare commands resolve through PATH/PATHEXT. When the session budget is full, the oldest exited sessions are reclaimed automatically; running sessions still require terminal_close.",
  list: "List sessions owned by this MCP instance. Set includeAll to see an inventory of the shared daemon. Other sessions require a handoff before use.",
  handoff:
    "Issue a one-time transfer token for a session you own. Pass the session ID and token to the intended recipient. Keep this MCP instance connected until adoption succeeds.",
  adopt:
    "Take ownership of a session using its ID and the current owner's one-time transfer token. The session will be cleaned up when this MCP instance disconnects.",
  observe:
    "Observe one TUI frame. view defaults to compact (trimmed text, no cells); full skips compact line trimming without cells; cells returns the complete terminal grid; diff requires fromFrameId from the previous observation and returns only changed lines/metadata. Recommended loop: compact -> inputAndWait -> diff with the previous snapshot.frameId. Screenshots are opt-in with screenshot:true.",
  input:
    "Send input to a running TUI. Use for text, bracketed paste, keys, clicks, wheel events or raw bytes when interacting with menus, prompts or alternate-screen apps. Wheel input supports page units and top/bottom endpoints. A successful call only means the input was delivered.",
  inputAndWait:
    "Send one input and wait for the TUI to visibly change. Use this to verify that a key, click or text entry had the intended effect; supports text, size, stability, cursor and exit conditions; never retries automatically.",
  find: "Locate text in the rendered terminal grid. Use to verify TUI labels or choose an interaction target. Finding text does not prove that it is a clickable application control.",
  clickText:
    "Locate text in the TUI and click it. Use for menu items, buttons rendered as text or other terminal controls; region-fingerprint protection guards against stale screens. hitbox/point/offset select the hit area. allowPendingFrame explicitly permits clicks before a synchronized frame is committed.",
  resize:
    "Resize the PTY and emulator. Use to test responsive TUI layouts; wait separately for the application's layout conditions.",
  wait: "Wait until all TUI conditions pass. Use instead of fixed sleeps after launch, input, resize or navigation. Supports text, style stability, size, cursor and exit.",
  metrics:
    "Read TuiLens byte, queue, backpressure and terminal-protocol reply counters without taking a screenshot. Use for diagnosing slow or lossy TUI output.",
  close: "Close a session owned by this MCP instance and release its process and browser resources.",
  compare:
    "Compare a TUI screenshot PNG with a read-only baseline and emit a difference image. Use for visual regression checks; mask coordinates are screenshot pixels.",
  replay:
    "Replay recorded terminal output offline and resize it without executing the program or recorded input. Use to inspect or test a captured TUI session; returns a screenshot.",
  scenario:
    "Run a repeatable TUI test from declarative steps. Use when the workflow should be rerun in CI or across profiles; retains failure evidence and releases the session. An optional profiles list runs the same scenario as a terminal matrix.",
  perf: "Measure interactive TUI performance: restart the program per round, sample input-to-visible-result latency and process-tree memory, compare with a baseline and fail on regression. Use for latency or memory regressions in terminal apps; an optional profiles list emits a comparison table.",
};

const MCP_TOOLS_ZH: McpToolDescriptions = {
  launch:
    "在真实 PTY 中启动 TuiLens 交互式终端会话。需要运行并操作全屏或菜单式 CLI（Ink、Textual、ratatui、bubbletea、curses、提示符、分页器等）时使用；简单非交互命令请使用普通 shell。返回会话 ID；每个 agent 应自行 launch 并管理自己的会话，不要复用另一个 agent 正在使用的 ID。可用 terminalProfile 选择内置预设或 JSON profile，graphics 覆盖图片协议。renderer 默认 headless；显式 dom/webgl 会立即激活 Chromium，截图则按需激活。Windows 裸命令会按 PATH/PATHEXT 解析。会话额度满时会自动回收最旧的已退出会话；运行中的会话仍需 terminal_close。",
  list: "列出当前 MCP 实例持有的会话。设置 includeAll 可查看共享 daemon 的会话概况，操作其他实例的会话需要先完成交接。",
  handoff: "为当前实例持有的会话签发一次性交接令牌。将会话 ID 和令牌交给接手方，接手成功前保持当前实例连接。",
  adopt: "凭会话 ID 和持有者提供的一次性令牌接手会话。当前 MCP 实例断开时会回收已接手的会话。",
  observe:
    "观察一个 TUI 帧。view 默认 compact（裁剪文本、不含字符格）；full 跳过 compact 行尾裁剪且不含字符格；cells 返回完整字符网格；diff 必须配合上一次观察返回的 fromFrameId，仅返回变化行和元数据。推荐循环：compact -> inputAndWait -> 带上一次 snapshot.frameId 的 diff。截图需显式传 screenshot:true。",
  input:
    "向运行中的 TUI 发送输入。操作菜单、提示符或全屏应用时用于文字、括号粘贴、按键、点击、滚轮或原始字节；滚轮支持 page 单位及 top/bottom 终点。只代表输入已送达。",
  inputAndWait:
    "发送一次输入并等待 TUI 画面可见变化。用于验证按键、点击或文字输入是否产生预期效果；支持文本、尺寸、稳定、光标和退出条件，不自动重发。",
  find: "从渲染后的终端字符格定位文字。用于核对 TUI 标签或选择交互目标；找到文字不等于业务控件可点击。",
  clickText:
    "在 TUI 中定位文字并点击。适用于菜单项、以文字渲染的按钮或其他终端控件；区域指纹会防止误点旧画面。可用 hitbox/point/offset 指定命中区；allowPendingFrame 显式允许同步帧未提交时点击。",
  resize: "改变 PTY 和模拟器尺寸。用于测试 TUI 的响应式布局；之后仍需等待应用布局条件。",
  wait: "等待全部 TUI 条件成立。用于替代启动、输入、resize 或导航后的固定 sleep；支持文字、样式稳定、尺寸、光标或退出。",
  metrics: "读取 TuiLens 的字节、排队、背压和终端协议应答计数，不截图。用于诊断 TUI 输出缓慢或丢失。",
  close: "关闭当前 MCP 实例持有的会话，并释放进程和浏览器资源。",
  compare: "将 TUI 截图 PNG 与只读基准图比较，输出差异图。用于视觉回归检查；遮罩坐标以截图像素计量。",
  replay: "离线重放录制的终端输出与 resize，不执行程序或输入。用于检查或测试已录制的 TUI 会话；返回截图。",
  scenario:
    "从声明式步骤运行可重复的 TUI 测试。需要在 CI 或 profile 矩阵中复跑工作流时使用；自动记录失败证据并回收本次会话。可选 profiles 列表运行同一场景的终端矩阵。",
  perf: "测量交互式 TUI 性能：按轮次重启被测程序、采样输入到可见结果的耗时与进程树内存，可与基线比较并在劣化时失败。用于排查终端应用的延迟或内存回归；可选 profiles 列表输出对比表。",
};

/** Default English descriptions for direct consumers. */
export const MCP_TOOLS = MCP_TOOLS_EN;

export function mcpTools(locale: Locale = resolveLocale()): McpToolDescriptions {
  return locale === "zh-CN" ? MCP_TOOLS_ZH : MCP_TOOLS_EN;
}

/** Server-wide guidance returned during MCP initialization and used alongside the tool list. */
export function mcpInstructions(locale: Locale = resolveLocale()): string {
  return locale === "zh-CN" ? MCP_INSTRUCTIONS_ZH : MCP_INSTRUCTIONS_EN;
}

export const MCP_TOOL_NAMES = Object.keys(MCP_TOOLS_EN) as McpMethod[];
