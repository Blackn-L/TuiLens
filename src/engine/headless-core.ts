import { createRequire } from "node:module";
import { snapshotLineCells } from "../core/diff.js";
import type {
  CursorState,
  FrameAccessOptions,
  MatchStyle,
  Region,
  RendererKind,
  ResolvedTerminalProfile,
  TerminalCell,
  TerminalEngine,
  TerminalModes,
  TerminalSnapshot,
  TerminalState,
  TextProbe,
} from "../core/types.js";
import { TuiLensError } from "../core/errors.js";
import { defaultTerminalProfile } from "../profiles/index.js";

const require = createRequire(import.meta.url);
const { Terminal: XtermTerminal } = require("@xterm/headless") as typeof import("@xterm/headless");
const { UnicodeGraphemesAddon } =
  require("@xterm/addon-unicode-graphemes") as typeof import("@xterm/addon-unicode-graphemes");

export const MAX_VISUAL_REPLAY_BYTES = 4 * 1024 * 1024;
export const MAX_VISUAL_REPLAY_EVENTS = 8192;

const BASE_PALETTE = [
  "#000000",
  "#cd0000",
  "#00cd00",
  "#cdcd00",
  "#0000ee",
  "#cd00cd",
  "#00cdcd",
  "#e5e5e5",
  "#7f7f7f",
  "#ff0000",
  "#00ff00",
  "#ffff00",
  "#5c5cff",
  "#ff00ff",
  "#00ffff",
  "#ffffff",
] as const;

function buildPalette(): string[] {
  const palette: string[] = [...BASE_PALETTE];
  const levels = [0, 95, 135, 175, 215, 255];
  const hex = (value: number): string => value.toString(16).padStart(2, "0");
  for (const red of levels) {
    for (const green of levels) {
      for (const blue of levels) palette.push(`#${hex(red)}${hex(green)}${hex(blue)}`);
    }
  }
  for (let index = 0; index < 24; index += 1) {
    const component = hex(8 + index * 10);
    palette.push(`#${component}${component}${component}`);
  }
  return palette;
}

function parseColor(value: string): string | undefined {
  if (/^#[0-9a-f]{6}$/iu.test(value)) return value.toLowerCase();
  if (/^#[0-9a-f]{3}$/iu.test(value)) {
    return `#${[...value.slice(1)].map((part) => part + part).join("")}`.toLowerCase();
  }
  const parts = /^rgb:([0-9a-f]{1,4})\/([0-9a-f]{1,4})\/([0-9a-f]{1,4})$/iu.exec(value);
  if (!parts) return undefined;
  return `#${parts
    .slice(1)
    .map((part) => Math.round((Number.parseInt(part, 16) / (16 ** part.length - 1)) * 255))
    .map((component) => component.toString(16).padStart(2, "0"))
    .join("")}`;
}

interface ReplayOutput {
  type: "output";
  data: string;
}

interface ReplayResize {
  type: "resize";
  cols: number;
  rows: number;
}

export type VisualReplayEvent = ReplayOutput | ReplayResize;

export interface VisualReplayState {
  events: VisualReplayEvent[];
  truncated: boolean;
  baseCols: number;
  baseRows: number;
  disabled: boolean;
}

/** 记录可视化层挂载所需的最近输出；按事件边界淘汰，避免从 ANSI 序列中间重放。 */
class VisualReplayBuffer {
  private events: VisualReplayEvent[] = [];
  private bytes = 0;
  private truncated = false;
  private disabled = false;
  constructor(
    private baseCols: number,
    private baseRows: number,
    private readonly limit = MAX_VISUAL_REPLAY_BYTES
  ) {}

  private evict(): void {
    const removed = this.events.shift();
    if (!removed) return;
    if (removed.type === "output") {
      this.bytes -= Buffer.byteLength(removed.data);
    } else {
      // The next buffered event must be replayed from the grid state after this resize.
      this.baseCols = removed.cols;
      this.baseRows = removed.rows;
    }
    this.truncated = true;
  }

  record(event: VisualReplayEvent): void {
    if (this.disabled) return;
    if (event.type === "output" && Buffer.byteLength(event.data) > this.limit) {
      this.truncated = true;
      return;
    }
    if (this.events.length >= MAX_VISUAL_REPLAY_EVENTS) {
      this.evict();
    }
    this.events.push(event);
    if (event.type === "output") this.bytes += Buffer.byteLength(event.data);
    while (this.bytes > this.limit && this.events.length > 0) this.evict();
  }

  snapshot(): VisualReplayState {
    return {
      events: [...this.events],
      truncated: this.truncated,
      baseCols: this.baseCols,
      baseRows: this.baseRows,
      disabled: this.disabled,
    };
  }

  disable(): void {
    if (this.disabled) return;
    this.disabled = true;
    this.events.length = 0;
    this.bytes = 0;
    this.truncated = false;
  }
}

export interface HeadlessCoreOptions {
  cols: number;
  rows: number;
  onData: (data: string) => void;
  profile?: ResolvedTerminalProfile;
  scrollback?: number;
  maxVisualReplayBytes?: number;
}

/**
 * 默认终端解析核心：不启动浏览器，只保留 xterm VT 状态和最近输出。
 * 可视化层挂载时可从这里按序重放，之后由组合引擎保持双写。
 */
export class HeadlessTerminalCore {
  readonly renderer: RendererKind = "headless";
  private readonly terminal: InstanceType<typeof XtermTerminal>;
  private readonly profile: ResolvedTerminalProfile;
  private readonly palette = buildPalette();
  private foreground = "#d4d4d4";
  private background = "#101114";
  private readonly replay: VisualReplayBuffer;
  private readonly listeners: { dispose(): void }[] = [];
  private cursorVisible = true;
  private cursorStyle: CursorState["style"] = "block";
  private cursorBlink = false;
  private mouseEncoding: "legacy" | "sgr" | "sgr-pixels" = "legacy";
  private kittyKeyboard = 0;
  private readonly kittyStack: number[] = [];
  private modifyOtherKeys: number | undefined;
  private closed = false;
  private readonly scrollback: number;

  constructor(private readonly options: HeadlessCoreOptions) {
    this.profile = options.profile ?? defaultTerminalProfile();
    const replayLimit = options.maxVisualReplayBytes ?? MAX_VISUAL_REPLAY_BYTES;
    if (!Number.isInteger(replayLimit) || replayLimit < 1 || replayLimit > MAX_VISUAL_REPLAY_BYTES) {
      throw new TuiLensError("INVALID_ARGUMENT", "maxVisualReplayBytes 必须是 1 B～4 MiB 的整数");
    }
    this.replay = new VisualReplayBuffer(options.cols, options.rows, replayLimit);
    this.scrollback = options.scrollback ?? this.profile.capabilities.scrollback ?? 2000;
    if (!Number.isInteger(this.scrollback) || this.scrollback < 0 || this.scrollback > 5000) {
      throw new TuiLensError("INVALID_PROFILE", "profile scrollback 必须是 0～5000 的整数");
    }
    this.terminal = new XtermTerminal({
      cols: options.cols,
      rows: options.rows,
      allowProposedApi: true,
      scrollback: this.scrollback,
      convertEol: false,
      drawBoldTextInBrightColors: false,
      minimumContrastRatio: 1,
      theme: {
        foreground: this.foreground,
        background: this.background,
        black: BASE_PALETTE[0],
        red: BASE_PALETTE[1],
        green: BASE_PALETTE[2],
        yellow: BASE_PALETTE[3],
        blue: BASE_PALETTE[4],
        magenta: BASE_PALETTE[5],
        cyan: BASE_PALETTE[6],
        white: BASE_PALETTE[7],
        brightBlack: BASE_PALETTE[8],
        brightRed: BASE_PALETTE[9],
        brightGreen: BASE_PALETTE[10],
        brightYellow: BASE_PALETTE[11],
        brightBlue: BASE_PALETTE[12],
        brightMagenta: BASE_PALETTE[13],
        brightCyan: BASE_PALETTE[14],
        brightWhite: BASE_PALETTE[15],
      },
    });
    this.terminal.loadAddon(new UnicodeGraphemesAddon());
    this.terminal.unicode.activeVersion = "15-graphemes";
    this.listeners.push(this.terminal.onData((data) => options.onData(data)));
    this.installModeTracking();
    this.installColorTracking();
    this.installReplyHandlers();
  }

  private installModeTracking(): void {
    for (const final of ["h", "l"] as const) {
      this.listeners.push(
        this.terminal.parser.registerCsiHandler({ prefix: "?", final }, (params) => {
          for (const value of params) {
            if (value === 1006) this.mouseEncoding = final === "h" ? "sgr" : "legacy";
            if (value === 1016) this.mouseEncoding = final === "h" ? "sgr-pixels" : "legacy";
            if (value === 25) this.cursorVisible = final === "h";
            if (value === 12) this.cursorBlink = final === "h";
          }
          return false;
        })
      );
    }
    this.listeners.push(
      this.terminal.parser.registerCsiHandler({ intermediates: " ", final: "q" }, (params) => {
        const raw = params[0];
        const value = Array.isArray(raw) ? raw[0] : raw;
        switch (value) {
          case 0:
          case 1:
            this.cursorStyle = "block";
            this.cursorBlink = true;
            break;
          case 2:
            this.cursorStyle = "block";
            this.cursorBlink = false;
            break;
          case 3:
            this.cursorStyle = "underline";
            this.cursorBlink = true;
            break;
          case 4:
            this.cursorStyle = "underline";
            this.cursorBlink = false;
            break;
          case 5:
            this.cursorStyle = "bar";
            this.cursorBlink = true;
            break;
          case 6:
            this.cursorStyle = "bar";
            this.cursorBlink = false;
            break;
          default:
            break;
        }
        return false;
      })
    );
    this.listeners.push(
      this.terminal.parser.registerEscHandler({ final: "c" }, () => {
        this.mouseEncoding = "legacy";
        this.cursorVisible = true;
        this.cursorStyle = "block";
        this.cursorBlink = false;
        return false;
      })
    );
    for (const prefix of [">", "=", "<"] as const) {
      this.listeners.push(
        this.terminal.parser.registerCsiHandler({ prefix, final: "u" }, (params) => {
          const raw = params[0];
          const value = Array.isArray(raw) ? (raw[0] ?? 0) : (raw ?? 0);
          if (prefix === ">") {
            this.kittyStack.push(this.kittyKeyboard);
            this.kittyKeyboard = value;
          } else if (prefix === "<") {
            const count = Math.max(1, value);
            for (let index = 0; index < count; index += 1) this.kittyKeyboard = this.kittyStack.pop() ?? 0;
          } else {
            const mode = Array.isArray(params[1]) ? params[1][0] : (params[1] ?? 1);
            if (mode === 2) this.kittyKeyboard |= value;
            else if (mode === 3) this.kittyKeyboard &= ~value;
            else this.kittyKeyboard = value;
          }
          return false;
        })
      );
    }
    this.listeners.push(
      this.terminal.parser.registerCsiHandler({ prefix: ">", final: "m" }, (params) => {
        const raw = params[0];
        const code = Array.isArray(raw) ? raw[0] : raw;
        if (code !== 4) return false;
        const level = Array.isArray(params[1]) ? params[1][0] : params[1];
        this.modifyOtherKeys = level === undefined ? 0 : level;
        return false;
      })
    );
  }

  private installColorTracking(): void {
    this.listeners.push(
      this.terminal.parser.registerOscHandler(4, (data) => {
        const parts = data.split(";");
        for (let index = 0; index + 1 < parts.length; index += 2) {
          const slot = Number(parts[index]);
          const color = parseColor(parts[index + 1] ?? "");
          if (Number.isInteger(slot) && slot >= 0 && slot < 256 && color) this.palette[slot] = color;
        }
        return false;
      })
    );
    this.listeners.push(
      this.terminal.parser.registerOscHandler(10, (data) => {
        const color = parseColor(data.split(";")[0] ?? "");
        if (color) this.foreground = color;
        return false;
      })
    );
    this.listeners.push(
      this.terminal.parser.registerOscHandler(11, (data) => {
        const color = parseColor(data.split(";")[0] ?? "");
        if (color) this.background = color;
        return false;
      })
    );
    this.listeners.push(
      this.terminal.parser.registerOscHandler(104, (data) => {
        const slots = data ? data.split(";").map(Number) : BASE_PALETTE.map((_, index) => index);
        for (const slot of slots) {
          if (Number.isInteger(slot) && BASE_PALETTE[slot]) this.palette[slot] = BASE_PALETTE[slot]!;
        }
        return false;
      })
    );
    this.listeners.push(
      this.terminal.parser.registerOscHandler(110, () => {
        this.foreground = "#d4d4d4";
        return false;
      })
    );
    this.listeners.push(
      this.terminal.parser.registerOscHandler(111, () => {
        this.background = "#101114";
        return false;
      })
    );
  }

  private installReplyHandlers(): void {
    const firstParam = (params: (number | number[])[]): number => {
      const value = params[0];
      return Array.isArray(value) ? (value[0] ?? 0) : (value ?? 0);
    };
    const respond = (data: string | undefined): void => {
      if (data) this.options.onData(data);
    };
    const replies = this.profile.replies;
    if (replies) {
      this.listeners.push(
        this.terminal.parser.registerCsiHandler({ final: "c" }, (params) => {
          if (firstParam(params) === 0) respond(replies.da1);
          return true;
        })
      );
      this.listeners.push(
        this.terminal.parser.registerCsiHandler({ prefix: ">", final: "c" }, (params) => {
          if (firstParam(params) === 0) respond(replies.da2);
          return true;
        })
      );
      this.listeners.push(
        this.terminal.parser.registerCsiHandler({ prefix: ">", final: "q" }, (params) => {
          if (firstParam(params) === 0) respond(replies.xtversion);
          return true;
        })
      );
    }
    const keyboard = this.profile.capabilities.keyboard;
    if (keyboard?.kitty !== undefined) {
      this.listeners.push(
        this.terminal.parser.registerCsiHandler({ prefix: "?", final: "u" }, (params) => {
          if (firstParam(params) === 0) respond(`\x1b[?${keyboard.kitty}u`);
          return true;
        })
      );
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new TuiLensError("ENGINE_CLOSED", "终端引擎已关闭");
  }

  async write(data: string): Promise<void> {
    this.assertOpen();
    this.replay.record({ type: "output", data });
    await new Promise<void>((resolve) => {
      this.terminal.write(data, resolve);
    });
  }

  async resize(cols: number, rows: number): Promise<void> {
    this.assertOpen();
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 2 || rows < 2 || cols > 500 || rows > 250) {
      throw new TuiLensError("INVALID_SIZE", "终端尺寸必须为 2–500 列、2–250 行的整数");
    }
    this.terminal.resize(cols, rows);
    this.replay.record({ type: "resize", cols, rows });
  }

  cursor(): CursorState {
    const buffer = this.terminal.buffer.active;
    return {
      x: buffer.cursorX,
      y: buffer.baseY + buffer.cursorY - buffer.viewportY,
      visible: this.cursorVisible,
      style: this.cursorStyle,
      blink: this.cursorBlink,
    };
  }

  modes(): TerminalModes {
    return {
      alternateScreen: this.terminal.buffer.active.type === "alternate",
      bracketedPaste: this.terminal.modes.bracketedPasteMode,
      applicationCursorKeys: this.terminal.modes.applicationCursorKeysMode,
      mouseTracking: this.terminal.modes.mouseTrackingMode,
      mouseEncoding: this.mouseEncoding,
      synchronizedOutput: this.terminal.modes.synchronizedOutputMode,
      ...(this.kittyKeyboard > 0 || this.modifyOtherKeys !== undefined
        ? {
            keyboard: {
              ...(this.kittyKeyboard > 0 ? { kitty: this.kittyKeyboard } : {}),
              ...(this.modifyOtherKeys !== undefined ? { modifyOtherKeys: this.modifyOtherKeys } : {}),
            },
          }
        : {}),
    };
  }

  state(): TerminalState {
    this.assertOpen();
    return {
      cols: this.terminal.cols,
      rows: this.terminal.rows,
      modes: this.modes(),
      cursor: this.cursor(),
    };
  }

  hasText(text: string): boolean {
    this.assertOpen();
    const buffer = this.terminal.buffer.active;
    for (let y = 0; y < this.terminal.rows; y += 1) {
      if (
        buffer
          .getLine(buffer.viewportY + y)
          ?.translateToString(false)
          .includes(text)
      )
        return true;
    }
    return false;
  }

  private cellColor(
    cell: NonNullable<ReturnType<NonNullable<ReturnType<typeof this.terminal.buffer.active.getLine>>["getCell"]>>,
    foregroundSide: boolean
  ): string {
    if (foregroundSide) {
      if (cell.isFgRGB()) return `#${cell.getFgColor().toString(16).padStart(6, "0")}`;
      if (cell.isFgPalette()) return this.palette[cell.getFgColor()] ?? this.foreground;
      return this.foreground;
    }
    if (cell.isBgRGB()) return `#${cell.getBgColor().toString(16).padStart(6, "0")}`;
    if (cell.isBgPalette()) return this.palette[cell.getBgColor()] ?? this.background;
    return this.background;
  }

  probeText(text: string, region?: Region, style?: MatchStyle): TextProbe {
    this.assertOpen();
    const buffer = this.terminal.buffer.active;
    const reusableCell = buffer.getNullCell();
    const area = region ?? { x: 0, y: 0, width: this.terminal.cols, height: this.terminal.rows };
    const matches: TextProbe["matches"] = [];
    let count = 0;
    const matchesStyle = (
      line: NonNullable<ReturnType<typeof buffer.getLine>>,
      start: number,
      end: number
    ): boolean => {
      if (!style) return true;
      for (let x = start; x < end; x += 1) {
        const cell = line.getCell(x, reusableCell);
        if (!cell) return false;
        const fg = this.cellColor(cell, true);
        const bg = this.cellColor(cell, false);
        const shownFg = cell.isInverse() ? bg : fg;
        const shownBg = cell.isInverse() ? fg : bg;
        if (style.fg !== undefined && shownFg.toLowerCase() !== style.fg.toLowerCase()) return false;
        if (style.bg !== undefined && shownBg.toLowerCase() !== style.bg.toLowerCase()) return false;
        if (style.bold !== undefined && Boolean(cell.isBold()) !== style.bold) return false;
        if (style.italic !== undefined && Boolean(cell.isItalic()) !== style.italic) return false;
        if (style.underline !== undefined && Boolean(cell.isUnderline()) !== style.underline) return false;
      }
      return true;
    };
    for (let y = area.y; y < area.y + area.height; y += 1) {
      const line = buffer.getLine(buffer.viewportY + y);
      if (!line) continue;
      let content = "";
      const starts: number[] = [];
      const ends: number[] = [];
      for (let x = area.x; x < area.x + area.width; x += 1) {
        const cell = line.getCell(x, reusableCell);
        if (!cell) continue;
        const width = cell.getWidth();
        if (width === 0) continue;
        const value = cell.getChars() || " ";
        if (x + width > area.x + area.width) continue;
        for (let offset = 0; offset < value.length; offset += 1) {
          starts.push(x);
          ends.push(x + Math.max(1, width));
        }
        content += value;
      }
      for (let offset = content.indexOf(text); offset >= 0; offset = content.indexOf(text, offset + 1)) {
        const start = starts[offset];
        const end = ends[offset + text.length - 1];
        if (start === undefined || end === undefined || !matchesStyle(line, start, end)) continue;
        count += 1;
        if (matches.length < 64) {
          matches.push({ text, region: { x: start, y, width: end - start, height: 1 } });
        }
      }
    }
    return { count, matches };
  }

  snapshot(frameId: number, options: FrameAccessOptions = {}): TerminalSnapshot {
    this.assertOpen();
    const buffer = this.terminal.buffer.active;
    const reusableCell = buffer.getNullCell();
    const includeGrid = options.cells !== false;
    const lineCells = snapshotLineCells.get(options);
    const scrollbackLines = options.scrollback ?? 0;
    const lines: string[] = [];
    const cells: TerminalCell[][] = [];
    for (let y = 0; y < this.terminal.rows; y += 1) {
      const line = buffer.getLine(buffer.viewportY + y);
      const text = line?.translateToString(true) ?? "";
      lines.push(text);
      // ASCII maps directly to columns. Only ambiguous rows need extra history, without cell style data.
      if (line && lineCells && /[^\x00-\x7f]/u.test(text)) {
        const layout: string[] = [];
        let offset = 0;
        const length = text.replace(/[ \t]+$/u, "").length;
        while (layout.length < line.length && offset < length) {
          const cell = line.getCell(layout.length, reusableCell)!;
          const chars = cell.getChars() || " ";
          layout.push(chars);
          if (cell.getWidth() === 2) layout.push("");
          offset += chars.length;
        }
        lineCells.set(y, layout);
      }
      if (!includeGrid) continue;
      const row: TerminalCell[] = [];
      for (let x = 0; x < this.terminal.cols; x += 1) {
        const cell = line?.getCell(x, reusableCell);
        const fg = cell ? this.cellColor(cell, true) : this.foreground;
        const bg = cell ? this.cellColor(cell, false) : this.background;
        row.push({
          x,
          y,
          text: cell?.getChars() ?? "",
          width: cell?.getWidth() ?? 1,
          fg,
          bg,
          bold: Boolean(cell?.isBold()),
          italic: Boolean(cell?.isItalic()),
          underline: Boolean(cell?.isUnderline()),
          inverse: Boolean(cell?.isInverse()),
        });
      }
      cells.push(row);
    }
    const snapshot: TerminalSnapshot = {
      frameId,
      capturedAt: new Date().toISOString(),
      cols: this.terminal.cols,
      rows: this.terminal.rows,
      text: lines.join("\n"),
      lines,
      cells,
      cursor: this.cursor(),
      modes: this.modes(),
    };
    if (scrollbackLines > 0) {
      const available = Math.max(0, buffer.viewportY);
      const wanted = Math.min(scrollbackLines, available);
      const from = available - wanted;
      const scrollback: string[] = [];
      for (let y = from; y < from + wanted; y += 1) {
        scrollback.push(buffer.getLine(y)?.translateToString(true) ?? "");
      }
      snapshot.scrollback = scrollback;
      if (scrollback.length < scrollbackLines) snapshot.scrollbackTruncated = true;
    }
    return snapshot;
  }

  replayState(): VisualReplayState {
    return this.replay.snapshot();
  }

  /** The visual layer is attached and receives writes directly; replay history is no longer needed. */
  disableReplayBuffer(): void {
    this.replay.disable();
  }

  async replayTo(
    engine: Pick<TerminalEngine, "write" | "resize">,
    finalSize?: { cols: number; rows: number }
  ): Promise<boolean> {
    const { events, truncated, baseCols, baseRows } = this.replayState();
    let cols = baseCols;
    let rows = baseRows;
    // Browser pages are created at the current size. Restore the original grid before
    // replaying output so data written after evicted resize events keeps its wrapping.
    await engine.resize(cols, rows);
    for (const event of events) {
      if (event.type === "output") await engine.write(event.data);
      else {
        await engine.resize(event.cols, event.rows);
        cols = event.cols;
        rows = event.rows;
      }
    }
    if (finalSize && (finalSize.cols !== cols || finalSize.rows !== rows)) {
      await engine.resize(finalSize.cols, finalSize.rows);
    }
    return truncated;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const listener of this.listeners.splice(0)) listener.dispose();
    this.terminal.dispose();
  }
}

export async function createHeadlessEngine(options: HeadlessCoreOptions): Promise<TerminalEngine> {
  const core = new HeadlessTerminalCore(options);
  return {
    renderer: core.renderer,
    write: (data) => core.write(data),
    resize: (cols, rows) => core.resize(cols, rows),
    state: async () => core.state(),
    hasText: async (text) => core.hasText(text),
    probeText: async (text, region, style) => core.probeText(text, region, style),
    snapshot: async (frameId, frame) => core.snapshot(frameId, frame),
    screenshot: async () => {
      throw new TuiLensError("BROWSER_REQUIRED", "纯无头引擎不能截图");
    },
    close: () => core.close(),
  };
}
