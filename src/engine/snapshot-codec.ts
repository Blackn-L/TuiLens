import { TuiLensError } from "../core/errors.js";
import type { TerminalCell } from "../core/types.js";

/**
 * 字符网格的跨进程编码。
 *
 * Playwright 的 `page.evaluate` 对深嵌套对象序列化极慢：160×50 网格的
 * 8000 个 cell 对象需要数百毫秒，而同样内容的扁平字符串只需数毫秒。
 * 因此浏览器侧把网格压成两个字符串，Node 侧再还原成公开的 cell 结构。
 *
 * 行格式（两种载荷各自按 "\n" 分行，行数必须等于 rows）：
 *
 * - `text`：行内 token 以 U+001F 分隔。
 *   - `e` / `E<count36>`：空字符格（text=""，width=1）
 *   - `s` / `S<count36>`：空格字符格（text=" "，width=1）
 *   - `c` / `C<count36>`：宽字符续格（text=""，width=0）
 *   - `t<chars>`：宽度 1，字符为 chars
 *   - `T<chars>`：宽度 2，字符为 chars
 * - `style`：行内游程，`<count36>,<fg>,<bg>,<flags>;` 依次拼接。
 *   fg/bg 为 6 位十六进制（不含 #），flags 为十六进制位掩码。
 *
 * 字符格文本不能跨行，也不含 U+001F，因此这两种分隔符不会与内容冲突。
 */
export interface PackedGrid {
  text: string;
  style: string;
}

const UNIT = "\u001f";
const STYLE_SEPARATOR = ";";
const STYLE_FIELDS = ",";

export const CELL_FLAG_BOLD = 1;
export const CELL_FLAG_ITALIC = 2;
export const CELL_FLAG_UNDERLINE = 4;
export const CELL_FLAG_INVERSE = 8;

function invalid(message: string): never {
  throw new TuiLensError("INVALID_SNAPSHOT", message);
}

function hex(value: string, label: string): string {
  if (!/^[0-9a-f]{6}$/u.test(value)) invalid(`${label} 不是 6 位十六进制颜色`);
  return `#${value}`;
}

/**
 * 还原为公开的 `TerminalCell` 二维数组。校验 token 总数与每行样式覆盖，
 * 任何不一致都视为引擎契约破坏，而不是尽量猜一个结果。
 */
export function unpackGrid(packed: PackedGrid, cols: number, rows: number): TerminalCell[][] {
  if (typeof packed?.text !== "string" || typeof packed.style !== "string") {
    invalid("压缩网格必须是字符串载荷");
  }
  const textRows = packed.text.split("\n");
  const styleRows = packed.style.split("\n");
  if (textRows.length !== rows) invalid(`压缩网格行数 ${textRows.length} 与 rows ${rows} 不一致`);
  const cells: TerminalCell[][] = [];
  for (let y = 0; y < rows; y += 1) {
    const row: TerminalCell[] = [];
    for (const token of (textRows[y] ?? "").split(UNIT)) {
      if (!token) continue;
      const kind = token[0]!;
      switch (kind) {
        case "e": case "s": case "c": {
          const raw = token.slice(1);
          const count = raw === "" ? 1 : Number.parseInt(raw, 36);
          if (!Number.isSafeInteger(count) || count < 1 || count > cols) {
            invalid(`无效的字符格游程长度：${raw}`);
          }
          const text = kind === "s" ? " " : "";
          const width = kind === "c" ? 0 : 1;
          for (let index = 0; index < count; index += 1) {
            row.push({} as TerminalCell);
            const cell = row[row.length - 1]!;
            cell.text = text;
            cell.width = width;
          }
          break;
        }
        case "t": case "T": {
          const text = token.slice(1);
          if (!text) invalid("文本 token 缺少内容");
          row.push({} as TerminalCell);
          const cell = row[row.length - 1]!;
          cell.text = text;
          cell.width = kind === "T" ? 2 : 1;
          break;
        }
        default: invalid(`未知的字符格 token：${kind}`);
      }
      if (row.length > cols) invalid(`第 ${y} 行字符格超过 ${cols} 列`);
    }
    if (row.length !== cols) invalid(`第 ${y} 行字符格数 ${row.length} 与 cols ${cols} 不一致`);

    // 样式按游程展开，长度必须恰好覆盖整行。
    let cursor = 0;
    for (const run of (styleRows[y] ?? "").split(STYLE_SEPARATOR)) {
      if (!run) continue;
      const parts = run.split(STYLE_FIELDS);
      if (parts.length !== 4) invalid(`第 ${y} 行样式游程字段数不正确`);
      const count = Number.parseInt(parts[0]!, 36);
      if (!Number.isSafeInteger(count) || count < 1) invalid(`第 ${y} 行样式游程长度无效`);
      const fg = hex(parts[1]!, "样式前景色");
      const bg = hex(parts[2]!, "样式背景色");
      const flags = Number.parseInt(parts[3]!, 16);
      if (!Number.isSafeInteger(flags) || flags < 0 || flags > 15) invalid(`第 ${y} 行样式标志无效`);
      for (let index = 0; index < count; index += 1) {
        const cell = row[cursor];
        if (!cell) invalid(`第 ${y} 行样式覆盖超出字符格数`);
        cell.x = cursor;
        cell.y = y;
        cell.fg = fg;
        cell.bg = bg;
        cell.bold = (flags & CELL_FLAG_BOLD) !== 0;
        cell.italic = (flags & CELL_FLAG_ITALIC) !== 0;
        cell.underline = (flags & CELL_FLAG_UNDERLINE) !== 0;
        cell.inverse = (flags & CELL_FLAG_INVERSE) !== 0;
        cursor += 1;
      }
    }
    if (cursor !== cols) invalid(`第 ${y} 行样式只覆盖 ${cursor} 个字符格，应为 ${cols}`);
    cells.push(row);
  }
  return cells;
}
