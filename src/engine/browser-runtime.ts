import type { Terminal } from "@xterm/xterm";
import type { ImageAddon, IImageAddonOptions } from "@xterm/addon-image";
import type {
  CursorState, TerminalGraphicsCapabilities, TerminalKeyboardCapabilities, TerminalModes,
  TerminalReplies, TerminalState,
} from "../core/types.js";
import type { KittyRuntime } from "./kitty-runtime.js";
import type { PackedGrid } from "./snapshot-codec.js";

/**
 * `snapshot` 的页面侧返回结构。字符网格以压缩字符串传出，
 * `grid` 未请求时完全不构造，避免为大网格付出无谓的打包成本。
 */
export interface PackedSnapshot {
  frameId: number;
  capturedAt: string;
  cols: number;
  rows: number;
  text: string;
  lines: string[];
  grid?: PackedGrid;
  cursor: CursorState;
  modes: TerminalModes;
  /** 视口上方的回滚行；只有显式请求时才出现。 */
  scrollback?: string[];
  scrollbackTruncated?: boolean;
}

export interface BrowserRuntime {
  write(data: string): Promise<void>;
  resize(cols: number, rows: number): void;
  settle(): Promise<void>;
  state(): TerminalState;
  hasText(text: string): boolean;
  size(): { width: number; height: number };
  snapshot(frameId: number, includeGrid: boolean, scrollbackLines: number): PackedSnapshot;
  dispose(): void;
}

interface RuntimeWindow extends Window {
  Terminal: typeof Terminal;
  UnicodeGraphemesAddon: {
    UnicodeGraphemesAddon: new () => { activate(terminal: Terminal): void; dispose(): void };
  };
  ImageAddon: { ImageAddon: new (options: IImageAddonOptions) => ImageAddon };
  __tuilensCreateKitty: Window["__tuilensCreateKitty"];
  __tuilens: BrowserRuntime;
  __tuilensData(data: string): Promise<void>;
}

export interface RuntimeOptions {
  cols: number;
  rows: number;
  fontFamily: string;
  fontSize: number;
  scrollback: number;
  graphics: Required<TerminalGraphicsCapabilities>;
  replies: TerminalReplies;
  keyboard?: TerminalKeyboardCapabilities;
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
    scrollback: options.scrollback,
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
  let cursorVisible = true;
  let cursorStyle: CursorState["style"] = "block";
  let cursorBlink = false;
  let mouseEncoding: "legacy" | "sgr" | "sgr-pixels" = "legacy";
  // xterm 的公开 modes 只暴露跟踪范围，编码需镜像已支持的 DECSET/DECRST。
  // 返回 false 让 xterm 继续执行默认处理；1005/1015 在 xterm 6 中不受支持。
  for (const final of ["h", "l"] as const) {
    listeners.push(terminal.parser.registerCsiHandler({ prefix: "?", final }, (params) => {
      for (const value of params) {
        if (value === 1006) mouseEncoding = final === "h" ? "sgr" : "legacy";
        if (value === 1016) mouseEncoding = final === "h" ? "sgr-pixels" : "legacy";
        if (value === 25) cursorVisible = final === "h";
        if (value === 12) cursorBlink = final === "h";
      }
      return false;
    }));
  }
  listeners.push(terminal.parser.registerCsiHandler({ intermediates: " ", final: "q" }, (params) => {
    const raw = params[0];
    const value = Array.isArray(raw) ? raw[0] : raw;
    switch (value) {
      case 0: case 1: cursorStyle = "block"; cursorBlink = true; break;
      case 2: cursorStyle = "block"; cursorBlink = false; break;
      case 3: cursorStyle = "underline"; cursorBlink = true; break;
      case 4: cursorStyle = "underline"; cursorBlink = false; break;
      case 5: cursorStyle = "bar"; cursorBlink = true; break;
      case 6: cursorStyle = "bar"; cursorBlink = false; break;
      default: break;
    }
    return false;
  }));
  listeners.push(terminal.parser.registerEscHandler({ final: "c" }, () => {
    mouseEncoding = "legacy";
    cursorVisible = true;
    cursorStyle = "block";
    cursorBlink = false;
    return false;
  }));
  // xterm 6 既不跟踪 Kitty keyboard protocol 也不处理 modifyOtherKeys，
  // 但真实终端会在应用协商后改变按键编码。这里镜像协商状态供输入编码使用；
  // 所有 handler 返回 false，让 xterm 继续按传统规则解析，不影响画面。
  let kittyKeyboard = 0;
  const kittyStack: number[] = [];
  for (const prefix of [">", "=", "<"] as const) {
    listeners.push(terminal.parser.registerCsiHandler({ prefix, final: "u" }, (params) => {
      const raw = params[0];
      const value = Array.isArray(raw) ? (raw[0] ?? 0) : (raw ?? 0);
      if (prefix === ">") {
        // CSI > flags u：压栈并启用。
        kittyStack.push(kittyKeyboard);
        kittyKeyboard = value;
      } else if (prefix === "<") {
        // CSI < number u：按数量弹栈，超量视为清空。
        const count = Math.max(1, value);
        for (let index = 0; index < count; index += 1) kittyKeyboard = kittyStack.pop() ?? 0;
      } else {
        // CSI = flags ; mode u：1 覆盖，2 增加，3 移除。
        const mode = Array.isArray(params[1]) ? params[1][0] : (params[1] ?? 1);
        if (mode === 2) kittyKeyboard |= value;
        else if (mode === 3) kittyKeyboard &= ~value;
        else kittyKeyboard = value;
      }
      return false;
    }));
  }
  let modifyOtherKeys: number | undefined;
  listeners.push(terminal.parser.registerCsiHandler({ prefix: ">", final: "m" }, (params) => {
    const raw = params[0];
    const code = Array.isArray(raw) ? raw[0] : raw;
    if (code !== 4) return false;
    const level = Array.isArray(params[1]) ? params[1][0] : params[1];
    modifyOtherKeys = level === undefined ? 0 : level;
    return false;
  }));
  // 查询响应走与用户输入相同的 PTY 回路；仅加载的图片协议才能被检测到。
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
  let renderVersion = 0;
  const renderWaiters = new Set<() => void>();
  listeners.push(terminal.onRender(() => {
    renderVersion += 1;
    for (const wake of renderWaiters) wake();
    renderWaiters.clear();
  }));
  const nextFrame = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => resolve()));
  const waitForRender = (version: number, timeoutMs = 2000): Promise<void> => new Promise((resolve) => {
    if (renderVersion > version) { resolve(); return; }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = () => {
      if (timer !== undefined) clearTimeout(timer);
      renderWaiters.delete(done);
      resolve();
    };
    renderWaiters.add(done);
    timer = setTimeout(done, timeoutMs);
  });
  const settle = async (): Promise<void> => {
    await document.fonts.ready;
    const version = renderVersion;
    terminal.refresh(0, terminal.rows - 1);
    await waitForRender(version);
    // write 回调只保证解析完成；两次动画帧让 xterm 绘制及浏览器合成完成。
    await nextFrame();
    await nextFrame();
    kittyRuntime?.render();
  };
  let imageAddon: ImageAddon | undefined;
  let kittyRuntime: KittyRuntime | undefined;
  const nativeWrite = (data: string): Promise<void> => new Promise((resolve) => terminal.write(data, resolve));
  const { sixel, iterm, kitty: kittyGraphics } = options.graphics;
  if (sixel || iterm) {
    imageAddon = new host.ImageAddon.ImageAddon({
      enableSizeReports: true, sixelSupport: sixel, iipSupport: iterm, iipSizeLimit: 8 * 1024 * 1024,
      sixelPaletteLimit: 4096, sixelSizeLimit: 8 * 1024 * 1024,
      pixelLimit: 4 * 1024 * 1024, storageLimit: 32, showPlaceholder: false,
    });
    terminal.loadAddon(imageAddon);
    // 上游解码器异步初始化但没有公开 ready Promise。用公开图像查询做有界预热，
    // 避免启动后的第一张图片在解码器尚未就绪时被无声丢弃。
    if (sixel) {
      const deadline = Date.now() + 5000;
      let ready = false;
      do {
        await nativeWrite("\x1b[H\x1bPq\"1;1;1;6#1;2;100;0;0#1~\x1b\\");
        ready = Boolean(imageAddon.getImageAtBufferCell(0, 0));
        if (!ready) await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      } while (!ready && Date.now() < deadline);
      await nativeWrite("\x1bc");
      if (!ready) throw new Error("SIXEL 解码器未能初始化");
    }
    if (iterm) {
      // 插件对损坏 JPEG/GIF 的异步解码拒绝没有恢复路径。公共 OSC hook
      // 在它之前有界预检，失败消费序列，成功才交给插件进行布局与存储。
      listeners.push(terminal.parser.registerOscHandler(1337, async (data) => {
        if (!data.startsWith("File=")) return true;
        const colon = data.indexOf(":");
        if (colon < 0) return true;
        try {
          const raw = Uint8Array.from(atob(data.slice(colon + 1)), (character) => character.charCodeAt(0));
          let timer: ReturnType<typeof setTimeout> | undefined;
          let expired = false;
          const decoding = createImageBitmap(new Blob([raw]));
          void decoding.then((bitmap) => { if (expired) bitmap.close(); }, () => {});
          try {
            const bitmap = await Promise.race([decoding, new Promise<never>((_, reject) => {
              timer = setTimeout(() => { expired = true; reject(new Error("image timeout")); }, 2000);
            })]);
            const valid = bitmap.width > 0 && bitmap.height > 0 && bitmap.width <= 4096 && bitmap.height <= 4096
              && bitmap.width * bitmap.height < 4 * 1024 * 1024;
            bitmap.close();
            if (!valid) return true;
          } finally { clearTimeout(timer); }
          return false;
        } catch { return true; }
      }));
    }
  }
  if (kittyGraphics) {
    kittyRuntime = host.__tuilensCreateKitty(terminal, (data) => { void host.__tuilensData(data); }, (cell) => {
      if (cell.isBgRGB()) return `#${cell.getBgColor().toString(16).padStart(6, "0")}`;
      if (cell.isBgPalette()) return palette[cell.getBgColor()] ?? background;
      return background;
    });
  }
  // profile 应答必须最后注册，才能压过 xterm 内置 DA 与 image addon 的 DA1 处理器。
  const firstParam = (params: (number | number[])[]): number => {
    const value = params[0];
    return Array.isArray(value) ? (value[0] ?? 0) : (value ?? 0);
  };
  const respond = (data: string | undefined): void => {
    if (data) void host.__tuilensData(data);
  };
  listeners.push(terminal.parser.registerCsiHandler({ final: "c" }, (params) => {
    if (firstParam(params) === 0) respond(options.replies.da1);
    return true;
  }));
  listeners.push(terminal.parser.registerCsiHandler({ prefix: ">", final: "c" }, (params) => {
    if (firstParam(params) === 0) respond(options.replies.da2);
    return true;
  }));
  listeners.push(terminal.parser.registerCsiHandler({ prefix: ">", final: "q" }, (params) => {
    if (firstParam(params) === 0) respond(options.replies.xtversion);
    return true;
  }));
  listeners.push(terminal.parser.registerCsiHandler({ prefix: "?", final: "u" }, (params) => {
    if (firstParam(params) === 0 && options.keyboard?.kitty !== undefined) {
      respond(`\x1b[?${options.keyboard.kitty}u`);
    }
    return true;
  }));
  // 输入和性能采样只读取协议状态，不能隐式遍历整个屏幕或等待动画帧。
  const cursorState = (): CursorState => {
    const buffer = terminal.buffer.active;
    return {
      x: buffer.cursorX,
      y: buffer.baseY + buffer.cursorY - buffer.viewportY,
      visible: cursorVisible,
      style: cursorStyle,
      blink: cursorBlink,
    };
  };
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
      ...(kittyKeyboard > 0 || modifyOtherKeys !== undefined
        ? { keyboard: {
          ...(kittyKeyboard > 0 ? { kitty: kittyKeyboard } : {}),
          ...(modifyOtherKeys !== undefined ? { modifyOtherKeys } : {}),
        } }
        : {}),
    },
    cursor: cursorState(),
  });
  host.__tuilens = {
    write: (data) => kittyRuntime ? kittyRuntime.write(data) : nativeWrite(data),
    resize: (cols, rows) => { terminal.resize(cols, rows); },
    settle,
    state,
    hasText: (text) => {
      const buffer = terminal.buffer.active;
      for (let y = 0; y < terminal.rows; y += 1) {
        if (buffer.getLine(buffer.viewportY + y)?.translateToString(false).includes(text)) return true;
      }
      return false;
    },
    size: () => {
      const element = container.querySelector<HTMLElement>(".xterm-screen");
      if (!element) throw new Error("Terminal screen is missing");
      const rectangle = element.getBoundingClientRect();
      return { width: Math.ceil(rectangle.width), height: Math.ceil(rectangle.height) };
    },
    snapshot: (frameId, includeGrid, scrollbackLines) => {
      const buffer = terminal.buffer.active;
      const reusableCell = buffer.getNullCell();
      const hex6 = (value: number): string => value.toString(16).padStart(6, "0");
      const lines: string[] = [];
      const textRows: string[] = [];
      const styleRows: string[] = [];
      // 回滚区只取视口之上的行；startY 为 0 表示没有可回滚内容。
      const scrollback: string[] | undefined = scrollbackLines > 0
        ? (() => {
          const available = Math.max(0, buffer.viewportY);
          const wanted = Math.min(scrollbackLines, available);
          const from = available - wanted;
          const rows: string[] = [];
          for (let y = from; y < from + wanted; y += 1) {
            rows.push(buffer.getLine(y)?.translateToString(true) ?? "");
          }
          return rows;
        })()
        : undefined;
      for (let y = 0; y < terminal.rows; y += 1) {
        const line = buffer.getLine(buffer.viewportY + y);
        lines.push(line?.translateToString(true) ?? "");
        if (!includeGrid) continue;
        // 单行内同时累积文本 token 与样式游程；空/空格/续格合并成游程以减小载荷。
        const tokens: string[] = [];
        const runs: string[] = [];
        let pendingKind = "";
        let pendingCount = 0;
        let runCount = 0;
        let runFg = "";
        let runBg = "";
        let runFlags = -1;
        const flushRun = (): void => {
          if (runCount === 0) return;
          runs.push(`${runCount.toString(36)},${runFg},${runBg},${(runFlags >>> 0).toString(16)};`);
          runCount = 0;
          runFlags = -1;
        };
        for (let x = 0; x < terminal.cols; x += 1) {
          const cell = line?.getCell(x, reusableCell);
          const width = cell?.getWidth() ?? 1;
          const chars = cell?.getChars() ?? "";
          const kind = width === 0 ? "c" : chars === "" ? "e" : chars === " " ? "s" : width === 2 ? "T" : "t";
          if (kind === "t" || kind === "T") {
            if (pendingCount > 0) {
              tokens.push(pendingCount === 1 ? pendingKind : `${pendingKind}${pendingCount.toString(36)}`);
              pendingCount = 0;
            }
            tokens.push(kind + chars);
          } else if (kind === pendingKind) {
            pendingCount += 1;
          } else {
            if (pendingCount > 0) {
              tokens.push(pendingCount === 1 ? pendingKind : `${pendingKind}${pendingCount.toString(36)}`);
            }
            pendingKind = kind;
            pendingCount = 1;
          }
          const fg = cell?.isFgRGB() ? hex6(cell.getFgColor())
            : cell?.isFgPalette() ? (palette[cell.getFgColor()] ?? foreground).slice(1) : foreground.slice(1);
          const bg = cell?.isBgRGB() ? hex6(cell.getBgColor())
            : cell?.isBgPalette() ? (palette[cell.getBgColor()] ?? background).slice(1) : background.slice(1);
          const flags = (cell?.isBold() ? 1 : 0) | (cell?.isItalic() ? 2 : 0)
            | (cell?.isUnderline() ? 4 : 0) | (cell?.isInverse() ? 8 : 0);
          if (fg !== runFg || bg !== runBg || flags !== runFlags) {
            flushRun();
            runFg = fg;
            runBg = bg;
            runFlags = flags;
          }
          runCount += 1;
        }
        if (pendingCount > 0) {
          tokens.push(pendingCount === 1 ? pendingKind : `${pendingKind}${pendingCount.toString(36)}`);
        }
        flushRun();
        textRows.push(tokens.join("\u001f"));
        styleRows.push(runs.join(""));
      }
      const snapshot: PackedSnapshot = {
        frameId,
        capturedAt: new Date().toISOString(),
        cols: terminal.cols,
        rows: terminal.rows,
        text: lines.join("\n"),
        lines,
        cursor: cursorState(),
        modes: state().modes,
      };
      if (includeGrid) snapshot.grid = { text: textRows.join("\n"), style: styleRows.join("\n") };
      if (scrollback) {
        snapshot.scrollback = scrollback;
        // 请求行数超过实际可用时明确标记，避免调用方误以为拿到了完整历史。
        if (scrollback.length < scrollbackLines) snapshot.scrollbackTruncated = true;
      }
      return snapshot;
    },
    dispose: () => {
      for (const listener of listeners) listener.dispose();
      kittyRuntime?.dispose();
      imageAddon?.dispose();
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
