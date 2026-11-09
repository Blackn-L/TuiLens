import type { IBufferCell, IDisposable, IMarker, Terminal } from "@xterm/xterm";

export interface KittyRuntime {
  write(data: string): Promise<void>;
  render(): void;
  dispose(): void;
  usage(): { images: number; bytes: number; placements: number; placementCells: number };
}

declare global {
  interface Window {
    __tuilensCreateKitty(
      terminal: Terminal,
      reply: (data: string) => void,
      background: (cell: IBufferCell) => string,
    ): KittyRuntime;
  }
}

/**
 * 在浏览器安装有界的 Kitty PNG/RGB 子集。仅处理内联传输，不读取文件或共享内存。
 * 函数作为 page.evaluate 的自包含入口，不能引用 Node.js 运行时变量。
 */
export function installKittyRuntime(diacritics: number[]): void {
  const host = window;
  host.__tuilensCreateKitty = (terminal, reply, background) => {
    const MAX_PIXELS = 4 * 1024 * 1024;
    const MAX_PAYLOAD = 8 * 1024 * 1024;
    const MAX_STORAGE = 32 * 1024 * 1024;
    const MAX_PLACEMENTS = 256;
    const MAX_PLACEMENT_CELLS = 65536;
    const indices = new Map(diacritics.map((code, index) => [code, index]));
    const placeholder = String.fromCodePoint(0x10eeee);
    const images = new Map<number, { bitmap: ImageBitmap; bytes: number }>();
    interface Placement {
      id: number;
      placementId: number;
      columns: number;
      rows: number;
      virtual: boolean;
      buffer: "normal" | "alternate";
      marker?: IMarker;
      absoluteY: number;
      x: number;
      signatures: Map<string, string>;
      damaged: Set<string>;
    }
    const placements: Placement[] = [];
    let placementCells = 0;
    let bytes = 0;
    let closed = false;
    let sequence = "";
    let mode: "text" | "esc" | "apc" | "apcEsc" | "string" | "stringEsc" = "text";
    let stringOsc = false;
    let pending: { keys: Record<string, string>; payload: string } | undefined;
    const canvas = document.createElement("canvas");
    canvas.className = "tuilens-kitty-layer";
    Object.assign(canvas.style, { position: "absolute", left: "0", top: "0", pointerEvents: "none", zIndex: "20" });
    const screen = terminal.element?.querySelector<HTMLElement>(".xterm-screen");
    if (!screen) throw new Error("终端画布尚未创建");
    screen.append(canvas);
    const context = canvas.getContext("2d");
    if (!context) throw new Error("无法创建图片画布");
    const nativeWrite = (data: string): Promise<void> => new Promise((resolve) => terminal.write(data, resolve));
    const signature = (cell: IBufferCell | undefined): string =>
      cell ? `${cell.getChars()}:${cell.getFgColorMode()}:${cell.getFgColor()}:${cell.getBgColorMode()}:${cell.getBgColor()}` : "";
    const releasePlacement = (placement: Placement): void => {
      placementCells -= placement.columns * placement.rows;
      placement.marker?.dispose();
    };
    const removePlacements = (matches: (placement: Placement) => boolean): void => {
      for (let i = placements.length - 1; i >= 0; i -= 1) {
        if (matches(placements[i]!)) releasePlacement(placements.splice(i, 1)[0]!);
      }
    };
    const removeImage = (id: number): void => {
      const old = images.get(id);
      if (old) { old.bitmap.close(); bytes -= old.bytes; images.delete(id); }
      removePlacements((placement) => placement.id === id);
    };
    const clear = (): void => {
      for (const id of [...images.keys()]) removeImage(id);
      pending = undefined;
    };
    const number = (keys: Record<string, string>, key: string, fallback: number): number => {
      const value = keys[key] === undefined ? fallback : Number(keys[key]);
      if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) throw new Error(`EINVAL:invalid ${key}`);
      return value;
    };
    const respond = (keys: Record<string, string>, message: string): void => {
      const quiet = number(keys, "q", 0);
      if (quiet === 2 || (quiet === 1 && message === "OK")) return;
      reply(`\x1b_Gi=${number(keys, "i", 0)}${keys.p ? `,p=${number(keys, "p", 0)}` : ""};${message}\x1b\\`);
    };
    const geometry = () => {
      const rectangle = screen.getBoundingClientRect();
      return {
        width: Math.ceil(rectangle.width), height: Math.ceil(rectangle.height),
        cellWidth: rectangle.width / terminal.cols, cellHeight: rectangle.height / terminal.rows,
      };
    };
    const paintTile = (image: ImageBitmap, placement: Placement, imageRow: number, imageCol: number, x: number, y: number, cw: number, ch: number): void => {
      // 虚拟矩形保留图像纵横比，留白由占位字符原背景提供。
      const scale = Math.min(placement.columns * cw / image.width, placement.rows * ch / image.height);
      const imageWidth = image.width * scale;
      const imageHeight = image.height * scale;
      const sx = imageCol * cw;
      const sy = imageRow * ch;
      const width = Math.min(cw, imageWidth - sx);
      const height = Math.min(ch, imageHeight - sy);
      if (width <= 0 || height <= 0) return;
      // 字符像素宽可能为小数，分块直接绘制会在相邻边缘产生透明接缝。
      // 所有图块共用同一像素边界取整规则，避免每块分别产生半透明边。
      const left = Math.round(x * cw), top = Math.round(y * ch);
      const right = Math.round(x * cw + width), bottom = Math.round(y * ch + height);
      context.drawImage(image, sx / scale, sy / scale, width / scale, height / scale, left, top, right - left, bottom - top);
    };
    const render = (): void => {
      if (closed || terminal.modes.synchronizedOutputMode) return;
      removePlacements((placement) => Boolean(placement.marker?.isDisposed));
      // DOM renderer 的系统字体通常没有私用占位符，缺字字形可能溢出格宽。
      // 仅替换显示层的占位符字素为空格；终端 buffer 保留原编码供定位和滚动。
      for (const span of terminal.element?.querySelectorAll(".xterm-rows span") ?? []) {
        const text = span.textContent ?? "";
        if (text.includes(placeholder)) span.textContent = text.replace(/\u{10eeee}\p{M}*/gu, " ");
      }
      const { width, height, cellWidth: cw, cellHeight: ch } = geometry();
      if (canvas.width !== width) canvas.width = width;
      if (canvas.height !== height) canvas.height = height;
      context.clearRect(0, 0, width, height);
      const buffer = terminal.buffer.active;
      const reusable = buffer.getNullCell();
      for (const placement of placements) {
        if (placement.virtual || placement.buffer !== buffer.type || placement.marker?.isDisposed) continue;
        const image = images.get(placement.id)?.bitmap;
        if (!image) continue;
        const originY = (placement.marker?.line ?? placement.absoluteY) - buffer.viewportY;
        for (let row = 0; row < placement.rows; row += 1) {
          const y = originY + row;
          if (y < 0 || y >= terminal.rows) continue;
          const line = buffer.getLine(buffer.viewportY + y);
          for (let col = 0; col < placement.columns; col += 1) {
            const x = placement.x + col;
            if (x < 0 || x >= terminal.cols) continue;
            const key = `${col},${row}`;
            if (signature(line?.getCell(x, reusable)) !== placement.signatures.get(key)) placement.damaged.add(key);
            if (!placement.damaged.has(key)) paintTile(image, placement, row, col, x, y, cw, ch);
          }
        }
      }
      // 虚拟放置由屏幕内真实字符格决定。正文覆盖占位符时自然消失，滚动时随格移动。
      for (let y = 0; y < terminal.rows; y += 1) {
        const line = buffer.getLine(buffer.viewportY + y);
        let previous: { id: number; row: number; col: number } | undefined;
        for (let x = 0; x < terminal.cols; x += 1) {
          const cell = line?.getCell(x, reusable);
          const chars = cell?.getChars() ?? "";
          if (!cell || !chars.startsWith(placeholder)) { previous = undefined; continue; }
          const marks = [...chars].slice(1).map((char) => indices.get(char.codePointAt(0)!));
          const low = cell.isFgRGB() || cell.isFgPalette() ? cell.getFgColor() : 0;
          const high = marks[2] ?? (previous ? Math.floor(previous.id / 0x1000000) : 0);
          const id = low + high * 0x1000000;
          const same = previous?.id === id;
          const row = marks[0] ?? (same ? previous!.row : 0);
          const col = marks[1] ?? (same && row === previous!.row ? previous!.col + 1 : 0);
          previous = { id, row, col };
          // 私用占位符是图像位置标记，即使图像被删除也不应显示字体缺字框。
          context.fillStyle = background(cell);
          context.fillRect(x * cw, y * ch, cw, ch);
          const placement = placements.find((p) => p.id === id && p.virtual);
          const image = images.get(id)?.bitmap;
          if (placement && image && row < placement.rows && col < placement.columns) {
            paintTile(image, placement, row, col, x, y, cw, ch);
          }
        }
      }
    };
    const place = async (keys: Record<string, string>, id: number): Promise<void> => {
      const image = images.get(id);
      if (!image) throw new Error("ENOENT:image not found");
      const virtual = number(keys, "U", 0) === 1;
      const placementId = number(keys, "p", 0);
      // 首版虚拟位置不读取 underline-color 私有 API，只支持一个无 placement-id 的虚拟矩形。
      if (virtual && placementId !== 0) throw new Error("ENOTSUP:virtual placement id");
      for (const key of ["x", "y", "w", "h", "X", "Y", "z", "P", "Q", "H", "V"]) {
        if (keys[key] !== undefined && Number(keys[key]) !== 0) throw new Error(`ENOTSUP:${key}`);
      }
      const { cellWidth: cw, cellHeight: ch } = geometry();
      const columns = number(keys, "c", Math.ceil(image.bitmap.width / cw));
      const rows = number(keys, "r", Math.ceil(image.bitmap.height / ch));
      if (!columns || !rows || columns > 500 || rows > 250) throw new Error("EINVAL:placement size");
      const replacing = (p: Placement): boolean => p.id === id && p.placementId === placementId && p.virtual === virtual;
      const replaced = placements.filter(replacing);
      const replacedCells = replaced.reduce((total, p) => total + p.columns * p.rows, 0);
      // 图片像素缓存之外，放置元数据也有独立累计预算；视口之外的声明面积同样计入。
      // 必须在构造任何逐格 Map 前拒绝超额请求，并保留此前有效放置。
      if (placementCells - replacedCells + columns * rows > MAX_PLACEMENT_CELLS) throw new Error("ENOSPC:placement cell limit");
      if (placements.length - replaced.length >= MAX_PLACEMENTS) throw new Error("ENOSPC:placement limit");
      const buffer = terminal.buffer.active;
      const x = buffer.cursorX;
      const absoluteY = buffer.baseY + buffer.cursorY;
      const signatures = new Map<string, string>();
      const reusable = buffer.getNullCell();
      if (!virtual) {
        for (let row = 0; row < rows; row += 1) {
          const line = buffer.getLine(absoluteY + row);
          if (!line) continue;
          for (let col = 0; col < Math.min(columns, terminal.cols - x); col += 1) {
            signatures.set(`${col},${row}`, signature(line.getCell(x + col, reusable)));
          }
        }
      }
      const marker = virtual ? undefined : terminal.registerMarker(0);
      removePlacements(replacing);
      placements.push({
        id, placementId, columns, rows, virtual, buffer: buffer.type,
        ...(marker ? { marker } : {}), absoluteY, x, signatures, damaged: new Set(),
      });
      placementCells += columns * rows;
      if (!virtual && number(keys, "C", 0) !== 1) {
        // 放置完成后向下移动至图像末行，再停到右侧下一格；超出右缘时由终端处理。
        await nativeWrite(`${"\n".repeat(rows - 1)}\x1b[${Math.min(terminal.cols, x + columns + 1)}G`);
      }
    };
    const decode = async (keys: Record<string, string>, payload: string): Promise<ImageBitmap> => {
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(payload) || payload.length % 4 !== 0) throw new Error("EINVAL:base64");
      const raw = Uint8Array.from(atob(payload), (char) => char.charCodeAt(0));
      const format = number(keys, "f", 32);
      if (format === 100) {
        const signature = [137, 80, 78, 71, 13, 10, 26, 10];
        if (raw.length < 45 || !signature.every((value, index) => raw[index] === value)) throw new Error("EINVAL:PNG");
        const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
        if (view.getUint32(8) !== 13 || String.fromCharCode(...raw.subarray(12, 16)) !== "IHDR") throw new Error("EINVAL:PNG header");
        const width = view.getUint32(16);
        const height = view.getUint32(20);
        if (!width || !height || width * height > MAX_PIXELS || width > 4096 || height > 4096) throw new Error("E2BIG:pixel limit");
        // 浏览器可能把 APNG 当首帧接受；协议子集明确不支持动画，因此先检查整个容器。
        let offset = 8, idat = false, ended = false;
        while (offset < raw.length) {
          if (offset + 12 > raw.length) throw new Error("EINVAL:PNG chunk");
          const length = view.getUint32(offset);
          const end = offset + 12 + length;
          if (end > raw.length) throw new Error("EINVAL:PNG chunk length");
          const type = String.fromCharCode(...raw.subarray(offset + 4, offset + 8));
          if (!/^[A-Za-z]{4}$/.test(type)) throw new Error("EINVAL:PNG chunk type");
          if (["acTL", "fcTL", "fdAT"].includes(type)) throw new Error("ENOTSUP:animated PNG");
          if (type === "IHDR" && offset !== 8) throw new Error("EINVAL:duplicate PNG header");
          let crc = 0xffffffff;
          for (let index = offset + 4; index < end - 4; index += 1) {
            crc ^= raw[index]!;
            for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
          }
          if (((crc ^ 0xffffffff) >>> 0) !== view.getUint32(end - 4)) throw new Error("EINVAL:PNG CRC");
          if (type === "IDAT") idat = true;
          if (type === "IEND") {
            if (length !== 0 || end !== raw.length || !idat) throw new Error("EINVAL:PNG end");
            ended = true;
          }
          offset = end;
        }
        if (!ended) throw new Error("EINVAL:PNG missing end");
        return createImageBitmap(new Blob([raw], { type: "image/png" }));
      }
      if (format !== 24 && format !== 32) throw new Error("ENOTSUP:pixel format");
      const width = number(keys, "s", 0), height = number(keys, "v", 0);
      if (!width || !height || width * height > MAX_PIXELS || width > 4096 || height > 4096) throw new Error("E2BIG:pixel limit");
      const channels = format / 8;
      if (raw.length !== width * height * channels) throw new Error("EINVAL:pixel length");
      const pixels = new Uint8ClampedArray(width * height * 4);
      for (let i = 0; i < width * height; i += 1) {
        pixels.set(raw.subarray(i * channels, i * channels + channels), i * 4);
        if (channels === 3) pixels[i * 4 + 3] = 255;
      }
      return createImageBitmap(new ImageData(pixels, width, height));
    };
    const command = async (data: string): Promise<void> => {
      const separator = data.indexOf(";");
      const header = separator < 0 ? data : data.slice(0, separator);
      const chunk = separator < 0 ? "" : data.slice(separator + 1);
      let keys: Record<string, string> = {};
      try {
        for (const field of header.split(",")) {
          if (!field) continue;
          const match = /^([a-zA-Z])=(-?\d+|[a-zA-Z])$/.exec(field);
          if (!match) throw new Error("EINVAL:control data");
          keys[match[1]!] = match[2]!;
        }
        if (number(keys, "q", 0) > 2) throw new Error("EINVAL:quiet");
        if (pending) {
          pending.payload += chunk;
          if (pending.payload.length > MAX_PAYLOAD) { pending = undefined; throw new Error("E2BIG:payload limit"); }
          if (keys.m === "1") return;
          keys = { ...pending.keys, m: "0" };
        } else if (keys.m === "1") {
          pending = { keys, payload: chunk };
          return;
        }
        const payload = pending?.payload ?? chunk;
        pending = undefined;
        const action = keys.a ?? "t";
        const id = number(keys, "i", 0);
        if (action === "d") {
          const target = keys.d ?? "a";
          if (!["a", "A", "i", "I"].includes(target)) throw new Error("ENOTSUP:delete mode");
          if (target.toLowerCase() === "a") {
            if (target === "A") clear();
            else removePlacements(() => true);
          } else if (target === "I") removeImage(id);
          else removePlacements((placement) => placement.id === id && (!keys.p || placement.placementId === number(keys, "p", 0)));
          render(); return;
        }
        if (action === "p") { await place(keys, id); respond(keys, "OK"); render(); return; }
        if (!["t", "T", "q"].includes(action)) throw new Error("ENOTSUP:action");
        if (keys.t && keys.t !== "d") throw new Error("ENOTSUP:transmission medium");
        if (keys.o || keys.I) throw new Error("ENOTSUP:compression or automatic id");
        if (!id) throw new Error("EINVAL:image id");
        const bitmap = await decode(keys, payload);
        if (action === "q") { bitmap.close(); respond(keys, "OK"); return; }
        const size = bitmap.width * bitmap.height * 4;
        // 替换数据保留已有位置；新缓存先逐出最旧图像。
        const old = images.get(id);
        if (old) { old.bitmap.close(); bytes -= old.bytes; images.delete(id); }
        while (images.size >= 128 || bytes + size > MAX_STORAGE) removeImage(images.keys().next().value!);
        images.set(id, { bitmap, bytes: size }); bytes += size;
        if (action === "T") await place(keys, id);
        respond(keys, "OK");
      } catch (error) {
        pending = undefined;
        const message = error instanceof Error ? error.message : "EINVAL:image decode";
        try { respond(keys, message); } catch { reply("\x1b_G;EINVAL:control data\x1b\\"); }
      }
      render();
    };
    const listeners: IDisposable[] = [
      terminal.onRender(render),
      terminal.onScroll(render),
      terminal.onResize(render),
      terminal.buffer.onBufferChange(() => { removePlacements((p) => !p.virtual && p.buffer === "alternate"); render(); }),
      terminal.parser.registerEscHandler({ final: "c" }, () => { clear(); return false; }),
      terminal.parser.registerCsiHandler({ final: "J" }, (params) => {
        const value = params[0] ?? 0;
        if (value === 2 || value === 3) removePlacements((p) => !p.virtual && p.buffer === terminal.buffer.active.type);
        return false;
      }),
      terminal.parser.registerCsiHandler({ final: "K" }, (params) => {
        const buffer = terminal.buffer.active;
        const row = buffer.baseY + buffer.cursorY;
        const mode = params[0] ?? 0;
        if (mode !== 0 && mode !== 1 && mode !== 2) return false;
        const first = mode === 0 ? buffer.cursorX : 0;
        const last = mode === 1 ? buffer.cursorX : terminal.cols - 1;
        for (const placement of placements) {
          const start = placement.marker?.line ?? placement.absoluteY;
          if (!placement.virtual && placement.buffer === buffer.type && row >= start && row < start + placement.rows) {
            const from = Math.max(0, first - placement.x);
            const to = Math.min(placement.columns - 1, last - placement.x);
            for (let col = from; col <= to; col += 1) placement.damaged.add(`${col},${row - start}`);
          }
        }
        return false;
      }),
    ];
    return {
      async write(data) {
        if (closed) throw new Error("图片解码器已关闭");
        let text = "";
        const flush = async () => { if (text) { const next = text; text = ""; await nativeWrite(next); } };
        // 保留跨 write 的 ESC/APC 状态；其他 DCS/OSC 字符串原样交给 xterm。
        for (const char of data) {
          if (mode === "text") {
            if (char === "\x1b") mode = "esc"; else text += char;
          } else if (mode === "esc") {
            if (char === "_") { await flush(); mode = "apc"; sequence = ""; }
            else {
              text += "\x1b" + char;
              if (char === "]" || char === "P" || char === "^") { mode = "string"; stringOsc = char === "]"; }
              else mode = "text";
            }
          } else if (mode === "apc" || mode === "apcEsc") {
            if (mode === "apcEsc" && char === "\\") {
              if (sequence.startsWith("G")) await command(sequence.slice(1));
              sequence = ""; mode = "text";
            } else {
              if (mode === "apcEsc") sequence += "\x1b";
              mode = char === "\x1b" ? "apcEsc" : "apc";
              if (char !== "\x1b") sequence += char;
              if (sequence.length > MAX_PAYLOAD + 4096) { pending = undefined; throw new Error("图片控制序列超过 8 MiB 上限"); }
            }
          } else {
            text += char;
            if (mode === "stringEsc") mode = char === "\\" ? "text" : "string";
            else if (char === "\x1b") mode = "stringEsc";
            else if (stringOsc && char === "\x07") mode = "text";
          }
        }
        await flush();
        render();
      },
      render,
      usage: () => ({ images: images.size, bytes, placements: placements.length, placementCells }),
      dispose() {
        if (closed) return;
        closed = true;
        for (const listener of listeners) listener.dispose();
        clear(); canvas.remove();
      },
    };
  };
}
