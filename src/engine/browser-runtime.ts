import type { Terminal } from "@xterm/xterm";
import type { TerminalSnapshot, TerminalState } from "../core/types.js";

export interface BrowserRuntime {
  write(data: string): Promise<void>;
  resize(cols: number, rows: number): void;
  settle(): Promise<void>;
  state(): TerminalState;
  size(): { width: number; height: number };
  snapshot(frameId: number): TerminalSnapshot;
  dispose(): void;
}

interface RuntimeWindow extends Window {
  Terminal: typeof Terminal;
  UnicodeGraphemesAddon: {
    UnicodeGraphemesAddon: new () => { activate(terminal: Terminal): void; dispose(): void };
  };
  __tuilens: BrowserRuntime;
  __tuilensData(data: string): Promise<void>;
}

export interface RuntimeOptions {
  cols: number;
  rows: number;
  fontFamily: string;
  fontSize: number;
}

/** 此函数整体传入浏览器执行，不能引用外部运行时变量或 Node.js API。 */
export async function initializeBrowserRuntime(options: RuntimeOptions): Promise<void> {
  const host = window as unknown as RuntimeWindow;
  const basePalette = [
    "#000000", "#cd0000", "#00cd00", "#cdcd00",
    "#0000ee", "#cd00cd", "#00cdcd", "#e5e5e5",
    "#7f7f7f", "#ff0000", "#00ff00", "#ffff00",
    "#5c5cff", "#ff00ff", "#00ffff", "#ffffff",
  ];
  const palette = [...basePalette];
  const levels = [0, 95, 135, 175, 215, 255];
  const hex = (value: number): string => value.toString(16).padStart(2, "0");
  for (let r = 0; r < 6; r += 1) {
    for (let g = 0; g < 6; g += 1) {
      for (let b = 0; b < 6; b += 1) {
        palette.push(`#${hex(levels[r] ?? 0)}${hex(levels[g] ?? 0)}${hex(levels[b] ?? 0)}`);
      }
    }
  }
  for (let index = 0; index < 24; index += 1) {
    const component = hex(8 + index * 10);
    palette.push(`#${component}${component}${component}`);
  }
  const defaultPalette = [...palette];
  let foreground = "#d4d4d4";
  let background = "#101114";
  const terminal = new host.Terminal({
    cols: options.cols,
    rows: options.rows,
    fontFamily: options.fontFamily,
    fontSize: options.fontSize,
    lineHeight: 1,
    letterSpacing: 0,
    cursorBlink: false,
    allowProposedApi: true,
    scrollback: 2000,
    convertEol: false,
    drawBoldTextInBrightColors: false,
    minimumContrastRatio: 1,
    theme: {
      foreground, background,
      black: basePalette[0]!, red: basePalette[1]!, green: basePalette[2]!, yellow: basePalette[3]!,
      blue: basePalette[4]!, magenta: basePalette[5]!, cyan: basePalette[6]!, white: basePalette[7]!,
      brightBlack: basePalette[8]!, brightRed: basePalette[9]!, brightGreen: basePalette[10]!, brightYellow: basePalette[11]!,
      brightBlue: basePalette[12]!, brightMagenta: basePalette[13]!, brightCyan: basePalette[14]!, brightWhite: basePalette[15]!,
    },
    windowOptions: {
      getCellSizePixels: true,
      getWinSizePixels: true,
      getWinSizeChars: true,
    },
  });
  terminal.loadAddon(new host.UnicodeGraphemesAddon.UnicodeGraphemesAddon());
  terminal.unicode.activeVersion = "15-graphemes";
  const container = document.querySelector<HTMLElement>("#terminal");
  if (!container) throw new Error("Terminal container is missing");
  terminal.open(container);
  const listeners = [
    terminal.onData((data) => { void host.__tuilensData(data); }),
  ];
  let mouseEncoding: "legacy" | "sgr" | "sgr-pixels" = "legacy";
  // xterm 的公开 modes 只暴露跟踪范围，编码需镜像已支持的 DECSET/DECRST。
  // 返回 false 让 xterm 继续执行默认处理；1005/1015 在 xterm 6 中不受支持。
  for (const final of ["h", "l"] as const) {
    listeners.push(terminal.parser.registerCsiHandler({ prefix: "?", final }, (params) => {
      for (const value of params) {
        if (value === 1006) mouseEncoding = final === "h" ? "sgr" : "legacy";
        if (value === 1016) mouseEncoding = final === "h" ? "sgr-pixels" : "legacy";
      }
      return false;
    }));
  }
  listeners.push(terminal.parser.registerEscHandler({ final: "c" }, () => {
    mouseEncoding = "legacy";
    return false;
  }));
  // 查询响应走与用户输入相同的 PTY 回路；不伪装 kitty/sixel 能力。
  const parseColor = (value: string): string | undefined => {
    if (/^#[0-9a-f]{6}$/i.test(value)) return value.toLowerCase();
    if (/^#[0-9a-f]{3}$/i.test(value)) {
      return `#${[...value.slice(1)].map((part) => part + part).join("")}`.toLowerCase();
    }
    const parts = /^rgb:([0-9a-f]{1,4})\/([0-9a-f]{1,4})\/([0-9a-f]{1,4})$/i.exec(value);
    if (!parts) return undefined;
    return "#" + parts.slice(1).map((part) => {
      return hex(Math.round(Number.parseInt(part, 16) / (16 ** part.length - 1) * 255));
    }).join("");
  };
  // public buffer 只保存颜色索引；镜像 OSC 调色板更新，颜色快照才能对应实际渲染。
  listeners.push(terminal.parser.registerOscHandler(4, (data) => {
    const parts = data.split(";");
    for (let index = 0; index + 1 < parts.length; index += 2) {
      const slot = Number(parts[index]);
      const color = parseColor(parts[index + 1] ?? "");
      if (Number.isInteger(slot) && slot >= 0 && slot < 256 && color) palette[slot] = color;
    }
    return false;
  }));
  for (const [code, setColor] of [
    [10, (color: string) => { foreground = color; }],
    [11, (color: string) => { background = color; }],
  ] as const) {
    listeners.push(terminal.parser.registerOscHandler(code, (data) => {
      const color = parseColor(data.split(";")[0] ?? "");
      if (color) setColor(color);
      return false;
    }));
  }
  listeners.push(terminal.parser.registerOscHandler(104, (data) => {
    const slots = data ? data.split(";").map(Number) : defaultPalette.map((_, index) => index);
    for (const slot of slots) {
      if (Number.isInteger(slot) && defaultPalette[slot]) palette[slot] = defaultPalette[slot]!;
    }
    return false;
  }));
  listeners.push(terminal.parser.registerOscHandler(110, () => {
    foreground = "#d4d4d4";
    return false;
  }));
  listeners.push(terminal.parser.registerOscHandler(111, () => {
    background = "#101114";
    return false;
  }));
  const settle = async (): Promise<void> => {
    await document.fonts.ready;
    // write 回调只保证解析完成；两次动画帧让 xterm 绘制及浏览器合成完成。
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  };
  // 输入和性能采样只读取协议状态，不能隐式遍历整个屏幕或等待动画帧。
  const state = (): TerminalState => ({
    cols: terminal.cols,
    rows: terminal.rows,
    modes: {
      alternateScreen: terminal.buffer.active.type === "alternate",
      bracketedPaste: terminal.modes.bracketedPasteMode,
      applicationCursorKeys: terminal.modes.applicationCursorKeysMode,
      mouseTracking: terminal.modes.mouseTrackingMode,
      mouseEncoding,
      synchronizedOutput: terminal.modes.synchronizedOutputMode,
    },
  });
  host.__tuilens = {
    write: (data) => new Promise<void>((resolve) => terminal.write(data, resolve)),
    resize: (cols, rows) => { terminal.resize(cols, rows); },
    settle,
    state,
    size: () => {
      const element = container.querySelector<HTMLElement>(".xterm-screen");
      if (!element) throw new Error("Terminal screen is missing");
      const rectangle = element.getBoundingClientRect();
      return { width: Math.ceil(rectangle.width), height: Math.ceil(rectangle.height) };
    },
    snapshot: (frameId) => {
      const buffer = terminal.buffer.active;
      const reusableCell = buffer.getNullCell();
      const rgb = (value: number): string => `#${value.toString(16).padStart(6, "0")}`;
      const cells: TerminalSnapshot["cells"] = [];
      const lines: string[] = [];
      for (let y = 0; y < terminal.rows; y += 1) {
        const line = buffer.getLine(buffer.viewportY + y);
        const row: TerminalSnapshot["cells"][number] = [];
        for (let x = 0; x < terminal.cols; x += 1) {
          const cell = line?.getCell(x, reusableCell);
          const fg = cell?.isFgRGB() ? rgb(cell.getFgColor())
            : cell?.isFgPalette() ? palette[cell.getFgColor()] ?? foreground : foreground;
          const bg = cell?.isBgRGB() ? rgb(cell.getBgColor())
            : cell?.isBgPalette() ? palette[cell.getBgColor()] ?? background : background;
          row.push({
            x, y,
            text: cell?.getChars() ?? "",
            width: cell?.getWidth() ?? 1,
            fg, bg,
            bold: Boolean(cell?.isBold()),
            italic: Boolean(cell?.isItalic()),
            underline: Boolean(cell?.isUnderline()),
            inverse: Boolean(cell?.isInverse()),
          });
        }
        cells.push(row);
        lines.push(line?.translateToString(true) ?? "");
      }
      return {
        frameId,
        capturedAt: new Date().toISOString(),
        cols: terminal.cols,
        rows: terminal.rows,
        text: lines.join("\n"),
        lines,
        cells,
        cursor: { x: buffer.cursorX, y: buffer.baseY + buffer.cursorY - buffer.viewportY },
        modes: state().modes,
      };
    },
    dispose: () => {
      for (const listener of listeners) listener.dispose();
      terminal.dispose();
    },
  };
  terminal.focus();
  await settle();
}

declare global {
  interface Window {
    __tuilens: BrowserRuntime;
  }
}
