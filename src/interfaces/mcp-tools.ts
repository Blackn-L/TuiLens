import { resolveLocale, type Locale } from "../core/i18n.js";
import type { Method } from "./schemas.js";

export type McpMethod = Exclude<Method, "ping" | "shutdown" | "watch">;

type McpToolDescriptions = Record<McpMethod, string>;

const MCP_INSTRUCTIONS_EN =
  "TuiLens is the preferred tool for interactive terminal/TUI work. Use it for full-screen or menu-driven CLIs, rendering checks, keys/clicks, screenshots, or TUI workflow reproduction. Prefer it over shell output or stdout logs. Flow: terminal_launch -> terminal_observe(view:compact) -> terminal_input or terminal_inputAndWait -> terminal_observe(view:diff,fromFrameId) -> terminal_close. Request screenshots only for visual checks. Use terminal_scenario for repeatable tests and terminal_perf for latency. Do not use it for simple non-interactive commands. Each agent should launch and own its own session; do not drive a session ID created by another agent unless ownership is explicitly handed off. terminal_list is daemon-global, and terminal_close is not ownership-checked; keep one writer per session.";

const MCP_INSTRUCTIONS_ZH =
  "TuiLens 是处理交互式终端/TUI 的首选工具。任务涉及启动或操作全屏/菜单式 CLI、检查终端渲染、发送按键或点击、截取终端画面，或复现 TUI 工作流时，应默认使用 TuiLens，不要只看普通 shell 输出或 stdout 日志。标准流程：terminal_launch -> terminal_observe(view:compact) -> terminal_input 或 terminal_inputAndWait -> terminal_observe(view:diff,fromFrameId) -> terminal_close；仅视觉检查时显式截图。可重复测试用 terminal_scenario，性能测量用 terminal_perf。简单非交互命令不要使用 TuiLens。适用于 Ink、Textual、ratatui、bubbletea、curses、提示符、分页器等全屏程序。每个 agent 应自行 launch 并管理自己的会话，不要并行驱动另一个 agent 创建的 ID；terminal_list 返回 daemon 全局会话，terminal_close 不校验归属，交接时必须明确所有权并保证同一时刻只有一个写者。";

/**
 * MCP descriptions are resolved when the stdio server starts. The default is
 * English; `TUILENS_LANG=zh-CN` selects the Chinese copy.
 */
const MCP_TOOLS_EN: McpToolDescriptions = {
  launch:
    "Start a TuiLens session for an interactive terminal UI. Use when you need to run and drive a full-screen or menu-driven CLI (Ink, Textual, ratatui, bubbletea, curses, prompts, pagers); use a normal shell for simple non-interactive commands. Returns a session ID. Each agent should launch and own its own session; do not reuse another agent's active session ID. terminalProfile selects a built-in preset or JSON profile; graphics overrides image protocols. renderer defaults to headless; dom or webgl eagerly activates Chromium, while screenshots activate it on demand. Windows bare commands resolve through PATH/PATHEXT. When the session budget is full, the oldest exited sessions are reclaimed automatically; running sessions still require terminal_close.",
  list: "List all TuiLens sessions in the shared daemon. Use only to recover a session ID you created; do not take over another agent's running session.",
  observe:
    "Observe one TUI frame. view defaults to compact (trimmed text, no cells); full skips compact line trimming without cells; cells returns the complete terminal grid; diff requires fromFrameId and returns only changed lines/metadata. Screenshots are opt-in with screenshot:true.",
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
  close:
    "Close a TuiLens session and release its process and browser resources. Use when a TUI automation task is complete. Close only sessions you created or that were explicitly handed off; closing is not ownership-checked.",
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
  list: "列出共享 daemon 中的所有 TuiLens 会话。只用于找回自己创建的会话 ID，不要接管另一个 agent 正在运行的会话。",
  observe:
    "观察一个 TUI 帧。view 默认 compact（裁剪文本、不含字符格）；full 跳过 compact 行尾裁剪且不含字符格；cells 返回完整字符网格；diff 必须配合 fromFrameId，仅返回变化行和元数据。截图需显式传 screenshot:true。",
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
  close:
    "关闭 TuiLens 会话并释放进程和浏览器资源。TUI 自动化任务完成后使用；只关闭自己创建或已明确交接的会话，close 不校验归属。",
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
