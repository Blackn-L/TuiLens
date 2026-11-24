import type { Region, SnapshotDiff, SnapshotFrame, SnapshotLineChange, TerminalModes } from "./types.js";

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function graphemes(text: string): string[] {
  return Array.from(graphemeSegmenter.segment(text), (part) => part.segment);
}

function inRange(codePoint: number, start: number, end: number): boolean {
  return codePoint >= start && codePoint <= end;
}

function isCombining(codePoint: number): boolean {
  return (
    inRange(codePoint, 0x0300, 0x036f) ||
    inRange(codePoint, 0x0483, 0x0489) ||
    inRange(codePoint, 0x0591, 0x05bd) ||
    inRange(codePoint, 0x0610, 0x061a) ||
    inRange(codePoint, 0x064b, 0x065f) ||
    inRange(codePoint, 0x0670, 0x0670) ||
    inRange(codePoint, 0x06d6, 0x06dc) ||
    inRange(codePoint, 0x0e31, 0x0e31) ||
    inRange(codePoint, 0x0e34, 0x0e3a) ||
    inRange(codePoint, 0x0e47, 0x0e4e) ||
    inRange(codePoint, 0x1ab0, 0x1aff) ||
    inRange(codePoint, 0x1dc0, 0x1dff) ||
    inRange(codePoint, 0x20d0, 0x20ff) ||
    inRange(codePoint, 0xfe20, 0xfe2f)
  );
}

function isWide(codePoint: number): boolean {
  return (
    inRange(codePoint, 0x1100, 0x115f) ||
    inRange(codePoint, 0x2329, 0x232a) ||
    inRange(codePoint, 0x2e80, 0x303e) ||
    inRange(codePoint, 0x3041, 0x33ff) ||
    inRange(codePoint, 0x3400, 0x4dbf) ||
    inRange(codePoint, 0x4e00, 0x9fff) ||
    inRange(codePoint, 0xa000, 0xa4cf) ||
    inRange(codePoint, 0xa960, 0xa97f) ||
    inRange(codePoint, 0xac00, 0xd7a3) ||
    inRange(codePoint, 0xf900, 0xfaff) ||
    inRange(codePoint, 0xfe10, 0xfe19) ||
    inRange(codePoint, 0xfe30, 0xfe6f) ||
    inRange(codePoint, 0xff00, 0xff60) ||
    inRange(codePoint, 0xffe0, 0xffe6) ||
    inRange(codePoint, 0x1f1e6, 0x1f1ff) ||
    inRange(codePoint, 0x1f200, 0x1f251) ||
    inRange(codePoint, 0x1f300, 0x1faff) ||
    inRange(codePoint, 0x20000, 0x3fffd)
  );
}

function graphemeWidth(grapheme: string): number {
  const codePoints = Array.from(grapheme, (character) => character.codePointAt(0) ?? 0);
  if (
    codePoints.length === 0 ||
    codePoints.every(
      (codePoint) =>
        isCombining(codePoint) ||
        codePoint === 0x200d ||
        codePoint === 0x200c ||
        codePoint === 0xfe0e ||
        codePoint === 0xfe0f
    )
  ) {
    return 0;
  }
  return codePoints.some(isWide) ? 2 : 1;
}

/** Display columns, not UTF-16 code units. */
export function displayWidth(text: string): number {
  return graphemes(text).reduce((width, grapheme) => width + graphemeWidth(grapheme), 0);
}

interface ChangedColumns {
  start: number;
  end: number;
}

function changedColumns(before: string, after: string, columns: number): ChangedColumns {
  const beforeParts = graphemes(before);
  const afterParts = graphemes(after);
  let prefix = 0;
  while (prefix < beforeParts.length && prefix < afterParts.length && beforeParts[prefix] === afterParts[prefix]) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < beforeParts.length - prefix &&
    suffix < afterParts.length - prefix &&
    beforeParts[beforeParts.length - 1 - suffix] === afterParts[afterParts.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  const start = Math.min(
    columns - 1,
    beforeParts.slice(0, prefix).reduce((width, grapheme) => width + graphemeWidth(grapheme), 0)
  );
  const beforeEnd = beforeParts
    .slice(0, beforeParts.length - suffix)
    .reduce((width, grapheme) => width + graphemeWidth(grapheme), 0);
  const afterEnd = afterParts
    .slice(0, afterParts.length - suffix)
    .reduce((width, grapheme) => width + graphemeWidth(grapheme), 0);
  const beforeWidth = beforeParts.reduce((width, grapheme) => width + graphemeWidth(grapheme), 0);
  const afterWidth = afterParts.reduce((width, grapheme) => width + graphemeWidth(grapheme), 0);
  // A shared suffix remains screen-stable only when both lines occupy the same total width.
  // Otherwise an insertion/deletion shifts every following cell, so the region extends to the line end.
  const changedEnd = beforeWidth === afterWidth ? Math.max(beforeEnd, afterEnd) : Math.max(beforeWidth, afterWidth);
  const end = Math.min(columns, Math.max(start + 1, changedEnd));
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
      const columns = changedColumns(change.before, change.after, target.cols);
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
