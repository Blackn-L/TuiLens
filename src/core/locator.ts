import type { MatchOptions, MatchStyle, Region, TerminalCell, TerminalSnapshot, TextMatch } from "./types.js";
import { createHash } from "node:crypto";
import { matchOptions, regionWithin } from "./validation.js";
import { TuiLensError } from "./errors.js";

/** 字符格到字符串的偏移映射保留 CJK、emoji 和组合字素的真实列宽。 */
export function findText(snapshot: TerminalSnapshot, text: string, region?: Region, options: MatchOptions = {}): TextMatch[] {
  if (typeof text !== "string" || !text || text.includes("\n") || text.includes("\r")) {
    throw new TuiLensError("INVALID_ARGUMENT", "定位文本必须非空且不能跨行");
  }
  matchOptions(options);
  const area = region ?? { x: 0, y: 0, width: snapshot.cols, height: snapshot.rows };
  regionWithin(area, snapshot.cols, snapshot.rows);
  const matches: TextMatch[] = [];
  for (let y = area.y; y < area.y + area.height; y += 1) {
    const line = snapshot.cells[y] ?? [];
    let content = "";
    const starts: number[] = [];
    const ends: number[] = [];
    for (let x = area.x; x < area.x + area.width; x += 1) {
      const cell = line[x];
      if (!cell || cell.width === 0) continue;
      const value = cell.text || " ";
      // 区域不得纳入被右边界截断的宽字符。
      if (x + cell.width > area.x + area.width) continue;
      for (let offset = 0; offset < value.length; offset += 1) {
        starts.push(x);
        ends.push(x + Math.max(1, cell.width));
      }
      content += value;
    }
    for (let offset = content.indexOf(text); offset >= 0; offset = content.indexOf(text, offset + 1)) {
      const start = starts[offset];
      const end = ends[offset + text.length - 1];
      if (start !== undefined && end !== undefined && matchesStyle(line, start, end, options.style)) {
        matches.push({ text, region: { x: start, y, width: end - start, height: 1 } });
      }
    }
  }
  return selectMatches(matches, options);
}

function matchesStyle(row: TerminalCell[], start: number, end: number, style?: MatchStyle): boolean {
  if (!style) return true;
  // 覆盖匹配范围的每个字符格，包括宽字符续格；反色时匹配用户实际看到的前景背景。
  for (let x = start; x < end; x += 1) {
    const cell = row[x];
    if (!cell) return false;
    const fg = cell.inverse ? cell.bg : cell.fg;
    const bg = cell.inverse ? cell.fg : cell.bg;
    if (style.fg !== undefined && fg.toLowerCase() !== style.fg.toLowerCase()) return false;
    if (style.bg !== undefined && bg.toLowerCase() !== style.bg.toLowerCase()) return false;
    if (style.bold !== undefined && cell.bold !== style.bold) return false;
    if (style.italic !== undefined && cell.italic !== style.italic) return false;
    if (style.underline !== undefined && cell.underline !== style.underline) return false;
  }
  return true;
}

function selectMatches(matches: TextMatch[], options: MatchOptions): TextMatch[] {
  if (options.nth !== undefined) {
    const result = matches[options.nth];
    if (!result) throw new TuiLensError("NO_MATCH", "指定序号没有匹配结果", { count: matches.length, nth: options.nth });
    return [result];
  }
  switch (options.selection) {
    case "unique":
      if (matches.length === 0) throw new TuiLensError("NO_MATCH", "未找到匹配文本");
      if (matches.length !== 1) throw new TuiLensError("AMBIGUOUS_MATCH", "文本存在多个匹配，请限定区域或样式", { count: matches.length });
      return matches;
    case "first": return matches.slice(0, 1);
    case "last": return matches.slice(-1);
    default: return matches;
  }
}

export function regionFingerprint(snapshot: TerminalSnapshot, region?: Region): string {
  const area = region ?? { x: 0, y: 0, width: snapshot.cols, height: snapshot.rows };
  regionWithin(area, snapshot.cols, snapshot.rows);
  // 不含时间戳、frameId 或光标闪烁；区域稳定只比较实际字符与样式。
  const value = JSON.stringify({
    cols: snapshot.cols,
    rows: snapshot.rows,
    cells: snapshot.cells.slice(area.y, area.y + area.height)
      .map((row) => row.slice(area.x, area.x + area.width)),
  });
  return createHash("sha256").update(value).digest("hex");
}
