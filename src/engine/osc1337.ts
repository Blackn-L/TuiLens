import { PNG } from "pngjs";
import { TuiLensError } from "../core/errors.js";

const ESC = "\x1b";
const MAX_FILE = 8 * 1024 * 1024;
const MAX_BASE64 = Math.ceil(MAX_FILE / 3) * 4;
const MAX_HEADER = 8192;
const MAX_PIXELS = 4 * 1024 * 1024;
interface Geometry { cols: number; rows: number; width: number; height: number }

/**
 * 按流归一化 IIP，补齐插件要求的 size 并组装 MultipartFile。
 * 只缓冲 OSC 1337，其他控制字符串原样转发；丢弃的图片不能变成键盘或文件动作。
 */
export class Osc1337Normalizer {
  private mode: "text" | "esc" | "prefix" | "image" | "imageEsc" | "other" | "otherEsc" = "text";
  private prefix = "";
  private sequence = "";
  private otherOsc = false;
  private discarded = false;
  private multipart: { header: string; parts: string[]; length: number } | undefined;
  private geometry: Geometry | undefined;

  setGeometry(geometry: Geometry): void { this.geometry = geometry; }

  write(data: string): string {
    const output: string[] = [];
    for (const char of data) {
      if (this.mode === "text") {
        if (char === ESC) this.mode = "esc";
        else if (char === "\x9d") { this.prefix = ""; this.mode = "prefix"; }
        else if (["\x90", "\x98", "\x9e", "\x9f"].includes(char)) {
          output.push(char); this.mode = "other"; this.otherOsc = false;
        }
        else output.push(char);
      } else if (this.mode === "esc") {
        if (char === ESC) output.push(ESC);
        else if (char === "]") { this.prefix = ""; this.mode = "prefix"; }
        else {
          output.push(ESC, char);
          this.mode = ["P", "_", "^", "X"].includes(char) ? "other" : "text";
          this.otherOsc = false;
          if (char === "c") this.multipart = undefined;
        }
      } else if (this.mode === "prefix") {
        this.prefix += char;
        if (this.prefix === "1337;") { this.sequence = ""; this.discarded = false; this.mode = "image"; }
        else if (!"1337;".startsWith(this.prefix)) {
          output.push(ESC, "]", this.prefix);
          this.mode = ["\x07", "\x18", "\x1a", "\x9c"].includes(char) ? "text" : char === ESC ? "otherEsc" : "other";
          this.otherOsc = true;
        }
      } else if (this.mode === "image" || this.mode === "imageEsc") {
        if ((this.mode === "imageEsc" && char === "\\") || char === "\x07" || char === "\x9c") {
          if (!this.discarded) output.push(this.complete(this.sequence));
          this.sequence = "";
          this.mode = "text";
        } else if (char === "\x18" || char === "\x1a") {
          this.multipart = undefined; this.sequence = ""; this.mode = "text";
        } else {
          if (this.mode === "imageEsc") this.discarded = true;
          this.mode = char === ESC ? "imageEsc" : "image";
          if (!this.discarded && char !== ESC) {
            this.sequence += char;
            if (this.sequence.length > MAX_BASE64 + MAX_HEADER) {
              this.sequence = ""; this.discarded = true; this.multipart = undefined;
            }
          }
        }
      } else {
        output.push(char);
        if (char === "\x18" || char === "\x1a" || char === "\x9c") this.mode = "text";
        else if (this.mode === "otherEsc") this.mode = char === "\\" ? "text" : char === ESC ? "otherEsc" : "other";
        else if (char === ESC) this.mode = "otherEsc";
        else if (this.otherOsc && char === "\x07") this.mode = "text";
      }
    }
    return output.join("");
  }

  private complete(sequence: string): string {
    try {
      if (sequence.startsWith("MultipartFile=")) {
        const header = sequence.slice(14);
        parseHeader(header);
        this.multipart = { header, parts: [], length: 0 };
        return "";
      }
      if (sequence.startsWith("FilePart=")) {
        const part = sequence.slice(9);
        if (!this.multipart || !/^[A-Za-z0-9+/]*={0,2}$/.test(part)) { this.multipart = undefined; return ""; }
        this.multipart.length += part.length;
        if (this.multipart.length > MAX_BASE64 || this.multipart.parts.length >= 16384) {
          this.multipart = undefined; return "";
        }
        this.multipart.parts.push(part);
        return "";
      }
      if (sequence === "FileEnd") {
        const current = this.multipart;
        this.multipart = undefined;
        return current ? normalize(current.header, current.parts.join(""), this.geometry) : "";
      }
      // 其他 OSC 1337 扩展不产生下载、剪贴板或 shell 副作用。
      if (!sequence.startsWith("File=")) return "";
      this.multipart = undefined;
      const separator = sequence.indexOf(":");
      if (separator < 0) return "";
      return normalize(sequence.slice(5, separator), sequence.slice(separator + 1), this.geometry);
    } catch {
      this.multipart = undefined;
      return "";
    }
  }
}

function parseHeader(header: string): Record<string, string> {
  if (header.length > MAX_HEADER) throw new Error("header limit");
  const fields: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const field of header.split(";")) {
    if (!field) continue;
    const separator = field.indexOf("=");
    if (separator <= 0) throw new Error("invalid field");
    const key = field.slice(0, separator), value = field.slice(separator + 1);
    if (!["name", "size", "width", "height", "preserveAspectRatio", "inline"].includes(key) || key in fields) {
      throw new Error("unsupported or duplicate field");
    }
    if (value.length > 1024) throw new Error("field limit");
    fields[key] = value;
  }
  if (fields.inline !== "1") throw new Error("only inline images");
  if (fields.size !== undefined && (!/^\d+$/.test(fields.size) || Number(fields.size) > MAX_FILE)) throw new Error("size limit");
  for (const key of ["width", "height"]) {
    const value = fields[key];
    if (value !== undefined && !/^(auto|[1-9]\d{0,5}(px|%)?)$/.test(value)) throw new Error("invalid dimension");
  }
  if (fields.preserveAspectRatio !== undefined && !["0", "1"].includes(fields.preserveAspectRatio)) throw new Error("invalid aspect ratio");
  if (fields.name && !/^[A-Za-z0-9+/]*={0,2}$/.test(fields.name)) throw new Error("invalid filename");
  return fields;
}

function dimensions(width: number, height: number) {
  if (!width || !height || width > 4096 || height > 4096 || width * height >= MAX_PIXELS) throw new Error("pixel limit");
  return { width, height };
}

function validateImage(data: Buffer): { width: number; height: number } {
  if (data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    if (data.length < 33 || data.readUInt32BE(8) !== 13 || data.toString("ascii", 12, 16) !== "IHDR") throw new Error("invalid PNG");
    const size = dimensions(data.readUInt32BE(16), data.readUInt32BE(20));
    // 不接受 APNG 或交错图；受控解码前先检查容器边界。
    if (data[28] !== 0 || data[24] !== 8 || data[26] !== 0 || data[27] !== 0
        || ![0, 2, 3, 4, 6].includes(data[25]!)) throw new Error("unsupported PNG");
    let ended = false;
    let imageData = false;
    let afterData = false;
    let count = 0;
    for (let offset = 8; offset < data.length;) {
      if (offset + 12 > data.length) throw new Error("truncated PNG");
      const length = data.readUInt32BE(offset);
      if (length > data.length - offset - 12) throw new Error("invalid PNG chunk");
      const type = data.toString("ascii", offset + 4, offset + 8);
      if (++count > 65536 || (type === "IHDR" && offset !== 8)) throw new Error("invalid PNG header");
      if (["acTL", "fcTL", "fdAT"].includes(type)) throw new Error("animation unsupported");
      if (type === "IDAT") {
        if (afterData) throw new Error("unordered PNG data");
        imageData = true;
      } else if (imageData) afterData = true;
      offset += length + 12;
      if (type === "IEND") { ended = length === 0 && imageData && offset === data.length; break; }
    }
    if (!ended) throw new Error("invalid PNG ending");
    const decoded = PNG.sync.read(data, { checkCRC: true });
    if (decoded.width !== size.width || decoded.height !== size.height) throw new Error("inconsistent PNG dimensions");
    return size;
  }
  if (["GIF87a", "GIF89a"].includes(data.toString("ascii", 0, 6)) && data.length >= 13) {
    const size = dimensions(data.readUInt16LE(6), data.readUInt16LE(8));
    let cursor = 13 + ((data[10]! & 128) ? 3 * 2 ** ((data[10]! & 7) + 1) : 0);
    let frames = 0;
    const skipBlocks = () => {
      for (;;) {
        if (cursor >= data.length) throw new Error("truncated GIF blocks");
        const length = data[cursor++]!;
        if (!length) return;
        cursor += length;
        if (cursor > data.length) throw new Error("invalid GIF block");
      }
    };
    while (cursor < data.length) {
      const marker = data[cursor++];
      if (marker === 0x3b) {
        if (!frames || cursor !== data.length) throw new Error("invalid GIF ending");
        return size;
      }
      if (marker === 0x21) { cursor += 1; skipBlocks(); continue; }
      if (marker !== 0x2c || cursor + 9 > data.length) throw new Error("invalid GIF frame");
      const frame = dimensions(data.readUInt16LE(cursor + 4), data.readUInt16LE(cursor + 6));
      if (data.readUInt16LE(cursor) + frame.width > size.width || data.readUInt16LE(cursor + 2) + frame.height > size.height) {
        throw new Error("GIF frame outside canvas");
      }
      const packed = data[cursor + 8]!;
      cursor += 9 + ((packed & 128) ? 3 * 2 ** ((packed & 7) + 1) : 0);
      cursor += 1;
      skipBlocks();
      frames += 1;
    }
    throw new Error("missing GIF ending");
  }
  if (data[0] === 0xff && data[1] === 0xd8) {
    let frame: { width: number; height: number } | undefined;
    for (let offset = 2; offset + 4 <= data.length;) {
      if (data[offset++] !== 0xff) throw new Error("invalid JPEG marker");
      while (data[offset] === 0xff) offset += 1;
      const marker = data[offset++];
      if (marker === 0xda && frame) return frame;
      if (marker === undefined || marker === 0xd9) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      const size = data.readUInt16BE(offset);
      if (size < 2 || offset + size > data.length) throw new Error("invalid JPEG segment");
      if ([0xc0, 0xc1, 0xc2].includes(marker)) {
        if (size < 8 || frame) throw new Error("invalid JPEG frame");
        frame = dimensions(data.readUInt16BE(offset + 5), data.readUInt16BE(offset + 3));
      } else if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        throw new Error("unsupported JPEG frame");
      }
      offset += size;
    }
  }
  throw new TuiLensError("UNSUPPORTED_IMAGE", "IIP supports PNG, JPEG and first-frame GIF only");
}

function normalize(header: string, payload: string, geometry?: Geometry): string {
  const fields = parseHeader(header);
  if (!payload || payload.length > MAX_BASE64 || !/^[A-Za-z0-9+/]*={0,2}$/.test(payload)
      || payload.length % 4 === 1) throw new Error("invalid base64");
  const raw = Buffer.from(payload, "base64");
  if (!raw.length || raw.length > MAX_FILE || (fields.size !== undefined && raw.length > Number(fields.size))) throw new Error("size limit");
  if (raw.toString("base64").replace(/=+$/, "") !== payload.replace(/=+$/, "")) throw new Error("noncanonical base64");
  const source = validateImage(raw);
  if (fields.preserveAspectRatio !== "0" && fields.width && fields.height
      && fields.width !== "auto" && fields.height !== "auto") {
    const pixels = (value: string, dimension: "width" | "height") => {
      if (value.endsWith("px")) return Number.parseInt(value);
      if (!geometry) return undefined;
      const total = geometry[dimension], cells = dimension === "width" ? geometry.cols : geometry.rows;
      return value.endsWith("%") ? Number.parseInt(value) * total / 100 : Number(value) * total / cells;
    };
    const width = pixels(fields.width, "width"), height = pixels(fields.height, "height");
    if (width !== undefined && height !== undefined) {
      const scale = Math.min(width / source.width, height / source.height);
      const fitted = dimensions(Math.floor(source.width * scale), Math.floor(source.height * scale));
      fields.width = `${fitted.width}px`;
      fields.height = `${fitted.height}px`;
      fields.preserveAspectRatio = "0";
    }
  }
  const parameters = Object.entries({ ...fields, size: String(raw.length) }).map(([key, value]) => `${key}=${value}`).join(";");
  return `${ESC}]1337;File=${parameters}:${raw.toString("base64")}\x07`;
}
