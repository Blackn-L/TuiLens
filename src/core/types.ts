/** 公共协议使用从 0 起算的字符格坐标；CSS 像素只用于截图尺寸。 */
export interface Region {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TerminalCell {
  x: number;
  y: number;
  text: string;
  width: number;
  fg: string;
  bg: string;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  inverse: boolean;
}

export interface TerminalModes {
  alternateScreen: boolean;
  bracketedPaste: boolean;
  applicationCursorKeys: boolean;
  mouseTracking: string;
  /** 鼠标跟踪模式与编码独立；首版输入仅支持字符格 SGR 编码。 */
  mouseEncoding?: "legacy" | "sgr" | "sgr-pixels";
  /** 同步输出期间，字符缓冲区可能已更新但可见画面尚未提交。 */
  synchronizedOutput?: boolean;
  /**
   * 应用已协商的键盘协议。`kitty` 为 Kitty keyboard protocol 的当前标志位，
   * `modifyOtherKeys` 为 xterm XTMODKEYS 级别（0–2）。未协商时两者都缺省，
   * 输入按传统 xterm 序列编码。
   */
  keyboard?: KeyboardProtocol;
}

export interface KeyboardProtocol {
  kitty?: number;
  modifyOtherKeys?: number;
}

export type CursorStyle = "block" | "underline" | "bar";

export interface CursorState {
  x: number;
  y: number;
  visible: boolean;
  style: CursorStyle;
  blink: boolean;
}

export interface TerminalState {
  cols: number;
  rows: number;
  modes: TerminalModes;
  cursor: CursorState;
}

export interface TerminalSnapshot {
  frameId: number;
  capturedAt: string;
  cols: number;
  rows: number;
  text: string;
  lines: string[];
  cells: TerminalCell[][];
  cursor: CursorState;
  modes: TerminalModes;
  /**
   * 视口上方、仍保留在终端回滚区中的行（从旧到新）。
   * 仅在请求了 `scrollback` 时出现；不含字符格。
   */
  scrollback?: string[];
  /** 请求的回滚行多于实际可用时，说明被截断的起始位置。 */
  scrollbackTruncated?: boolean;
}

export interface TextMatch {
  text: string;
  region: Region;
  frameId?: number;
  fingerprint?: string;
}

export interface MatchStyle {
  fg?: string;
  bg?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
}

export interface MatchOptions {
  style?: MatchStyle;
  /** unique 拒绝重名匹配；nth 从 0 起算。 */
  selection?: "all" | "unique" | "first" | "last";
  nth?: number;
}

export interface ClickHitbox {
  left?: number;
  right?: number;
  top?: number;
  bottom?: number;
}

export interface ClickTextOptions extends MatchOptions {
  /** 显式读取同步输出尚未提交的字符格；区域指纹保护仍然有效。 */
  allowPendingFrame?: boolean;
  hitbox?: ClickHitbox;
  point?: "center" | "left" | "right" | "top" | "bottom";
  offset?: { x?: number; y?: number };
  button?: "left" | "middle" | "right";
  modifiers?: Modifiers;
}

export interface InputGuard {
  frameId?: number;
  region?: { bounds: Region; fingerprint: string };
}

export type ImageProfile = "off" | "sixel" | "iterm" | "all";
export interface Modifiers { shift?: boolean; ctrl?: boolean; alt?: boolean }

export interface LaunchOptions {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  cols?: number;
  rows?: number;
  colorMode?: "truecolor" | "ansi256" | "none";
  images?: ImageProfile;
  recording?: { maxBytes?: number };
  protocolReplies?: {
    mode?: "auto" | "forward" | "suppress";
    maxLatencyMs?: number;
  };
}

export interface SessionInfo {
  id: string;
  pid: number;
  cols: number;
  rows: number;
  status: "running" | "exited" | "closed";
  exitCode: number | null;
  createdAt: string;
  recordingPath?: string;
  resolvedCommand?: string;
}

export interface Observation {
  session: SessionInfo;
  snapshot: TerminalSnapshot;
  screenshot: null | {
    path: string;
    width: number;
    height: number;
    frameId: number;
    region?: Region;
    cursor?: "hidden" | "shown";
  };
}

export interface ObserveOptions {
  screenshot?: boolean;
  /** 字符格裁剪，仅影响 PNG；状态仍返回完整 viewport。 */
  region?: Region;
  /** 默认隐藏截图光标，避免块状光标遮挡字符。 */
  cursor?: "hide" | "show";
  /**
   * 是否返回完整字符网格。默认为 true；只读取 text/lines/光标或仅需要截图时
   * 置为 false，可以省掉整屏网格的跨进程传输。为 false 时 `cells` 是空数组。
   */
  cells?: boolean;
  /**
   * 同时返回视口上方的回滚行数（1–5000，从旧到新）。
   * 回滚内容只有文本；用于断言已滚出屏幕的历史消息。
   */
  scrollback?: number;
}

export type InputAction =
  | { type: "text"; text: string }
  | { type: "paste"; text: string }
  | { type: "key"; key: string }
  | { type: "click"; x: number; y: number; button?: "left" | "middle" | "right"; modifiers?: Modifiers }
  | { type: "move"; x: number; y: number; modifiers?: Modifiers }
  | { type: "mouseDown" | "mouseUp"; x: number; y: number; button?: "left" | "middle" | "right"; modifiers?: Modifiers }
  | { type: "drag"; from: { x: number; y: number }; to: { x: number; y: number }; steps?: number; button?: "left" | "middle" | "right"; modifiers?: Modifiers }
  | { type: "scroll"; x: number; y: number; direction: "up" | "down"; unit?: "line" | "page"; amount?: number; modifiers?: Modifiers }
  | { type: "scroll"; x: number; y: number; to: "top" | "bottom"; modifiers?: Modifiers }
  | { type: "raw"; data: string };

export interface FrameAccessOptions {
  allowPendingFrame?: boolean;
  /**
   * 默认为 true。为 false 时引擎不构造也不传输字符网格，
   * 只返回 text、lines、cursor 与 modes；此类快照不能用于 find 或区域指纹。
   */
  cells?: boolean;
  /**
   * 同时返回视口上方的回滚行（1–5000 行，从旧到新）。
   * 只包含文本，不包含字符格；用于断言已经滚出屏幕的历史内容。
   */
  scrollback?: number;
}

export type WaitCondition =
  | { kind: "text"; text: string; region?: Region; absent?: boolean; style?: MatchStyle; count?: number }
  | { kind: "size"; cols: number; rows: number }
  | { kind: "stable"; region?: Region; durationMs?: number }
  | { kind: "exited" }
  | { kind: "cursor"; x?: number; y?: number; visible?: boolean; style?: CursorStyle; blink?: boolean };

export interface WaitOptions {
  conditions: WaitCondition[];
  timeoutMs?: number;
  signal?: AbortSignal;
  afterFrameId?: number;
}

export interface BrowserEngineOptions {
  cols: number;
  rows: number;
  onData: (data: string) => void;
  executablePath?: string;
  fontFamily?: string;
  fontSize?: number;
  images?: ImageProfile;
}

/** 终端适配器不持有进程；替换引擎无需修改 CLI/MCP 或等待规则。 */
export interface TerminalEngine {
  write(data: string): Promise<void>;
  resize(cols: number, rows: number): Promise<void>;
  /** 只读取尺寸与模式，不等待绘制，也不遍历或传输字符网格。 */
  state(): Promise<TerminalState>;
  /** 可选快速文本条件：避免等待普通标记时跨进程传输整屏字符格。 */
  hasText?(text: string): Promise<boolean>;
  snapshot(frameId: number, options?: FrameAccessOptions): Promise<TerminalSnapshot>;
  screenshot(region?: Region, options?: { cursor?: "hide" | "show" }): Promise<{ png: Buffer; width: number; height: number }>;
  close(): Promise<void>;
}

export type EngineFactory = (options: BrowserEngineOptions) => Promise<TerminalEngine>;

export interface ManagerOptions {
  artifactDir: string;
  executablePath?: string;
  fontFamily?: string;
  engineFactory?: EngineFactory;
  /** 同时保留的会话（含回放任务）上限，默认 8；矩阵测试等场景可调高。 */
  maxSessions?: number;
}

export interface WaitResult {
  observation: Observation;
  elapsedMs: number;
}

export interface InputWaitOptions {
  /** 为空时只等待输入后至少一个新 frameId。 */
  conditions?: WaitCondition[];
  /** 仅限制等待；截图启用时另有独立的最小采集预算。 */
  timeoutMs?: number;
}

export interface InputAndWaitResult {
  session: SessionInfo;
  inputFrameId: number;
  cursorBefore: CursorState;
  observation: Observation;
  elapsedMs: number;
}
