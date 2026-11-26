import type {
  FrameAccessOptions,
  Region,
  SnapshotDiff,
  SnapshotFrame,
  SnapshotLineChange,
  TerminalModes,
} from "./types.js";

/** Captures in-process geometry without adding callbacks or private fields to serializable engine options. */
export const snapshotLineCells = new WeakMap<FrameAccessOptions, Map<number, readonly string[]>>();

interface ChangedColumns {
  start: number;
  end: number;
}

function lineColumns(frame: SnapshotFrame, y: number): string | readonly string[] | undefined {
  const measured = frame.lineCells?.get(y);
  if (measured) return measured;
  const text = frame.lines[y] ?? "";
  if (!/[^\x00-\x7f]/u.test(text)) return text;
  // Legacy text-only frames can still locate ASCII and double-width CJK ideographs exactly.
  const cells: string[] = [];
  for (const char of text) {
    cells.push(char);
    if (char.charCodeAt(0) <= 0x7f) continue;
    if (!/^\p{Unified_Ideograph}$/u.test(char)) return undefined;
    cells.push("");
  }
  return cells;
}

function changedColumns(base: SnapshotFrame, target: SnapshotFrame, y: number): ChangedColumns {
  const before = lineColumns(base, y);
  const after = lineColumns(target, y);
  if (before === undefined || after === undefined) return { start: 0, end: target.cols };
  let start = 0;
  let end = Math.max(before.length, after.length);
  while (start < end && before[start] === after[start]) start += 1;
  while (end > start && before[end - 1] === after[end - 1]) end -= 1;
  if (start > 0 && (before[start] === "" || after[start] === "")) start -= 1;
  // Both glyphs may be wide, with their differing lead cells followed by equal continuation markers.
  if (before[end] === "" || after[end] === "") end += 1;
  return { start, end };
}

function equalValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((value, index) => equalValue(value, right[index]));
  }
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return false;
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  if (leftKeys.length !== rightKeys.length) return false;
  for (let index = 0; index < leftKeys.length; index += 1) {
    const key = leftKeys[index]!;
    if (key !== rightKeys[index] || !equalValue(leftRecord[key], rightRecord[key])) return false;
  }
  return true;
}

function modesChanged(base: TerminalModes, target: TerminalModes): boolean {
  return !equalValue(base, target);
}

/** Pure comparison over the bounded snapshot frames retained by ManagedSession. */
export function diffSnapshots(base: SnapshotFrame, target: SnapshotFrame): SnapshotDiff {
  const changedLines: SnapshotLineChange[] = [];
  const rowCount = Math.max(base.lines.length, target.lines.length, base.rows, target.rows);
  for (let y = 0; y < rowCount; y += 1) {
    const before = base.lines[y] ?? "";
    const after = target.lines[y] ?? "";
    if (before !== after) changedLines.push({ y, before, after });
  }

  let changedRegion: Region | undefined;
  if (changedLines.length > 0) {
    let start = Number.POSITIVE_INFINITY;
    let end = 0;
    let top = Number.POSITIVE_INFINITY;
    let bottom = 0;
    for (const change of changedLines) {
      const columns = changedColumns(base, target, change.y);
      start = Math.min(start, columns.start);
      end = Math.max(end, columns.end);
      top = Math.min(top, change.y);
      bottom = Math.max(bottom, change.y);
    }
    const y = Math.min(Math.max(0, top), target.rows - 1);
    const lastY = Math.min(Math.max(y, bottom), target.rows - 1);
    const x = Math.min(Math.max(0, start), target.cols - 1);
    changedRegion = {
      x,
      y,
      width: Math.max(1, Math.min(target.cols, Math.max(x + 1, end)) - x),
      height: Math.max(1, lastY - y + 1),
    };
  }

  const resized = base.cols !== target.cols || base.rows !== target.rows;
  const cursorChanged = !equalValue(base.cursor, target.cursor);
  const modesDiffer = modesChanged(base.modes, target.modes);
  return {
    baseFrameId: base.frameId,
    targetFrameId: target.frameId,
    unchanged: changedLines.length === 0 && !resized && !cursorChanged && !modesDiffer,
    ...(resized ? { resized: true } : {}),
    ...(cursorChanged ? { cursorChanged: true } : {}),
    ...(modesDiffer ? { modesChanged: true } : {}),
    changedLines,
    ...(changedRegion ? { changedRegion } : {}),
  };
}
