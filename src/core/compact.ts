import type { TerminalSnapshot } from "./types.js";

/**
 * 面向 Agent 的紧凑快照：保留行列、光标和模式，只裁掉行尾空白与字符格。
 * 行数不变，避免调用方把压缩后的文本误当成另一张网格。
 */
export function compactSnapshot(snapshot: TerminalSnapshot): TerminalSnapshot {
  const lines = snapshot.lines.map((line) => line.replace(/[ \t]+$/u, ""));
  return {
    ...snapshot,
    lines,
    text: lines.join("\n"),
    cells: [],
  };
}
