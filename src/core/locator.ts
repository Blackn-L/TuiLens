import type { Region, TerminalSnapshot, TextMatch } from "./types.js";
import { regionWithin } from "./validation.js";
import { TuiLensError } from "./errors.js";

/** 字符格到字符串的偏移映射保留 CJK、emoji 和组合字素的真实列宽。 */
export function findText(snapshot: TerminalSnapshot, text: string, region?: Region): TextMatch[] {
  if (!text || text.includes("\n") || text.includes("\r")) {
    throw new TuiLensError("INVALID_ARGUMENT", "定位文本必须非空且不能跨行");
  }
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
      if (start !== undefined && end !== undefined) {
        matches.push({ text, region: { x: start, y, width: end - start, height: 1 } });
      }
    }
  }
  return matches;
}

export function regionFingerprint(snapshot: TerminalSnapshot, region?: Region): string {
  const area = region ?? { x: 0, y: 0, width: snapshot.cols, height: snapshot.rows };
  regionWithin(area, snapshot.cols, snapshot.rows);
  // 不含时间戳、frameId 或光标闪烁；区域稳定只比较实际字符与样式。
  return JSON.stringify({
    cols: snapshot.cols,
    rows: snapshot.rows,
    cells: snapshot.cells.slice(area.y, area.y + area.height)
      .map((row) => row.slice(area.x, area.x + area.width)),
  });
}
