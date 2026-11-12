import type { Method } from "./schemas.js";

export type McpMethod = Exclude<Method, "ping" | "shutdown">;

/** MCP 暴露的是 CLI/SDK 共用方法；ping 与 shutdown 仅保留本机协议入口。 */
export const MCP_TOOLS: Record<McpMethod, string> = {
  launch: "在真实 PTY 中启动程序。返回会话 ID；Windows 裸命令会按 PATH/PATHEXT 解析。",
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
  scenario: "运行声明式场景步骤，自动记录失败证据并回收本次会话。",
  perf: "运行性能场景：按轮次重启被测程序、采样输入到可见结果的耗时与进程树内存，可与基线比较并在劣化时失败。",
};

export const MCP_TOOL_NAMES = Object.keys(MCP_TOOLS) as McpMethod[];
