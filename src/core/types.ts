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
}

export interface TerminalState {
  cols: number;
  rows: number;
  modes: TerminalModes;
}

export interface TerminalSnapshot {
  frameId: number;
  capturedAt: string;
  cols: number;
  rows: number;
  text: string;
  lines: string[];
  cells: TerminalCell[][];
  cursor: { x: number; y: number };
  modes: TerminalModes;
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
}

export interface Observation {
  session: SessionInfo;
  snapshot: TerminalSnapshot;
  screenshot: null | { path: string; width: number; height: number; frameId: number; region?: Region };
}

export interface ObserveOptions {
  screenshot?: boolean;
  /** 字符格裁剪，仅影响 PNG；状态仍返回完整 viewport。 */
  region?: Region;
}

export type InputAction =
  | { type: "text"; text: string }
  | { type: "paste"; text: string }
  | { type: "key"; key: string }
  | { type: "click"; x: number; y: number; button?: "left" | "middle" | "right"; modifiers?: Modifiers }
  | { type: "move"; x: number; y: number; modifiers?: Modifiers }
  | { type: "mouseDown" | "mouseUp"; x: number; y: number; button?: "left" | "middle" | "right"; modifiers?: Modifiers }
  | { type: "drag"; from: { x: number; y: number }; to: { x: number; y: number }; steps?: number; button?: "left" | "middle" | "right"; modifiers?: Modifiers }
  | { type: "scroll"; x: number; y: number; direction: "up" | "down"; amount?: number; modifiers?: Modifiers }
  | { type: "raw"; data: string };

export type WaitCondition =
  | { kind: "text"; text: string; region?: Region; absent?: boolean; style?: MatchStyle; count?: number }
  | { kind: "size"; cols: number; rows: number }
  | { kind: "stable"; region?: Region; durationMs?: number }
  | { kind: "exited" };

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
  snapshot(frameId: number): Promise<TerminalSnapshot>;
  screenshot(region?: Region): Promise<{ png: Buffer; width: number; height: number }>;
  close(): Promise<void>;
}

export type EngineFactory = (options: BrowserEngineOptions) => Promise<TerminalEngine>;

export interface ManagerOptions {
  artifactDir: string;
  executablePath?: string;
  fontFamily?: string;
  engineFactory?: EngineFactory;
}

export interface WaitResult {
  observation: Observation;
  elapsedMs: number;
}
