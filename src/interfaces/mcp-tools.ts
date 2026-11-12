import { resolveLocale, type Locale } from "../core/i18n.js";
import type { Method } from "./schemas.js";

export type McpMethod = Exclude<Method, "ping" | "shutdown">;

type McpToolDescriptions = Record<McpMethod, string>;

/**
 * MCP descriptions are resolved when the stdio server starts. The default is
 * English; `TUILENS_LANG=zh-CN` selects the Chinese copy.
 */
const MCP_TOOLS_EN: McpToolDescriptions = {
  launch: "Launch a program in a real PTY. Returns a session ID. terminalProfile selects a built-in preset or JSON profile; graphics overrides image protocols. Windows bare commands resolve through PATH/PATHEXT.",
  list: "List TuiLens sessions.",
  observe: "Freeze output consumption and capture the same frame's character grid and terminal PNG; the screenshot cursor is hidden by default.",
  input: "Send text, bracketed paste, keys, clicks, wheel events or raw bytes. Wheel input supports page units and top/bottom endpoints. A successful call only means the input was delivered.",
  inputAndWait: "Send one input, then wait for a visible result or new frame. Supports text, size, stability, cursor and exit conditions; never retries automatically.",
  find: "Locate text in the character grid. Finding text does not prove that it is a clickable application control.",
  clickText: "Locate text and click with region-fingerprint protection; hitbox/point/offset select the hit area. allowPendingFrame explicitly permits clicks before a synchronized frame is committed.",
  resize: "Resize the PTY and emulator. Wait separately for the application's layout conditions.",
  wait: "Wait until all conditions pass. Supports text, style stability, size, cursor and exit.",
  metrics: "Read byte, queue, backpressure and terminal-protocol reply counters without taking a screenshot.",
  close: "Close a session and release its process and browser resources.",
  compare: "Compare an actual PNG with a read-only baseline and emit a difference image; mask coordinates are screenshot pixels.",
  replay: "Replay recorded terminal output and resizes offline without executing the program or recorded input; returns a screenshot.",
  scenario: "Run declarative scenario steps, retain failure evidence and release the session. An optional profiles list runs the same scenario as a terminal matrix.",
  perf: "Run a performance scenario: restart the program per round, sample input-to-visible-result latency and process-tree memory, compare with a baseline and fail on regression. An optional profiles list emits a terminal comparison table.",
};

const MCP_TOOLS_ZH: McpToolDescriptions = {
  launch: "在真实 PTY 中启动程序。返回会话 ID；可用 terminalProfile 选择内置预设或 JSON profile，graphics 覆盖图片协议；Windows 裸命令会按 PATH/PATHEXT 解析。",
  list: "列出 TuiLens 会话。",
  observe: "冻结输出消费，获取同一 frameId 的字符格和实际终端 PNG；默认隐藏截图光标。",
  input: "发送文字、括号粘贴、按键、点击、滚轮或原始字节；滚轮支持 page 单位及 top/bottom 终点。只代表输入已送达。",
  inputAndWait: "发送一次输入后等待可见结果或新帧；支持文本、尺寸、稳定、光标和退出条件，不自动重发。",
  find: "从字符格定位文字；找到文字不等于业务控件可点击。",
  clickText: "定位后按区域指纹保护点击；可用 hitbox/point/offset 指定命中区。allowPendingFrame 显式允许同步帧未提交时点击。",
  resize: "改变 PTY 和模拟器尺寸。之后仍需等待应用布局条件。",
  wait: "等待全部条件成立；支持文字、样式稳定、尺寸、光标或退出。",
  metrics: "读取字节、排队、背压和终端协议应答计数；不截图。",
  close: "关闭会话并释放进程和浏览器资源。",
  compare: "将实际 PNG 与只读基准图比较，输出差异图；遮罩坐标以截图像素计量。",
  replay: "离线重放录制的终端输出与 resize，不执行程序或输入，返回截图。",
  scenario: "运行声明式场景步骤，自动记录失败证据并回收本次会话；可选 profiles 列表运行同一场景的终端矩阵。",
  perf: "运行性能场景：按轮次重启被测程序、采样输入到可见结果的耗时与进程树内存，可与基线比较并在劣化时失败；可选 profiles 列表输出终端对比表。",
};

/** Default English descriptions for direct consumers. */
export const MCP_TOOLS = MCP_TOOLS_EN;

export function mcpTools(locale: Locale = resolveLocale()): McpToolDescriptions {
  return locale === "zh-CN" ? MCP_TOOLS_ZH : MCP_TOOLS_EN;
}

export const MCP_TOOL_NAMES = Object.keys(MCP_TOOLS_EN) as McpMethod[];
