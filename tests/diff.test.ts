import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { diffSnapshots } from "../src/core/diff.js";
import { observeSchema } from "../src/core/protocol.js";
import type { SnapshotFrame } from "../src/core/types.js";

function frame(frameId: number, lines: string[], overrides: Partial<SnapshotFrame> = {}): SnapshotFrame {
  return {
    frameId,
    cols: 20,
    rows: lines.length,
    lines,
    cursor: { x: 0, y: 0, visible: true, style: "block", blink: false },
    modes: {
      alternateScreen: false,
      bracketedPaste: false,
      applicationCursorKeys: false,
      mouseTracking: "none",
    },
    ...overrides,
  };
}

test("无变化帧返回 unchanged 且没有差异区域", () => {
  const base = frame(1, ["hello", "world"]);
  const target = frame(2, ["hello", "world"], {
    cursor: { ...base.cursor },
    modes: { ...base.modes },
  });
  const diff = diffSnapshots(base, target);
  assert.equal(diff.unchanged, true);
  assert.deepEqual(diff.changedLines, []);
  assert.equal(diff.changedRegion, undefined);
  assert.equal(diff.resized, undefined);
  assert.equal(diff.cursorChanged, undefined);
  assert.equal(diff.modesChanged, undefined);
});

test("局部行变更返回前后文本和字符包围盒", () => {
  const diff = diffSnapshots(frame(1, ["hello world", "tail"]), frame(2, ["hello WORLD", "tail"]));
  assert.equal(diff.unchanged, false);
  assert.deepEqual(diff.changedLines, [{ y: 0, before: "hello world", after: "hello WORLD" }]);
  assert.deepEqual(diff.changedRegion, { x: 6, y: 0, width: 5, height: 1 });
});

test("CJK 宽字符按显示列计算包围盒", () => {
  const diff = diffSnapshots(frame(1, ["A文B"]), frame(2, ["A中文B"]));
  assert.deepEqual(diff.changedRegion, { x: 1, y: 0, width: 2, height: 1 });
});

test("resize、光标和模式变化均单独报告", () => {
  const base = frame(1, ["one", "two"]);
  const resized = diffSnapshots(
    base,
    frame(2, ["one", "two", "three"], {
      cols: 10,
      rows: 3,
      cursor: { ...base.cursor, x: 2 },
      modes: { ...base.modes, bracketedPaste: true },
    })
  );
  assert.equal(resized.resized, true);
  assert.equal(resized.cursorChanged, true);
  assert.equal(resized.modesChanged, true);
  assert.equal(resized.unchanged, false);
  assert.ok(resized.changedLines.some((change) => change.y === 2));
  assert.ok(resized.changedRegion);
});

test("observe schema 要求 diff 必须提供 fromFrameId", () => {
  const id = randomUUID();
  assert.equal(observeSchema.safeParse({ id, view: "diff" }).success, false);
  assert.equal(observeSchema.safeParse({ id, view: "diff", fromFrameId: 0 }).success, true);
  assert.equal(observeSchema.safeParse({ id, view: "compact" }).success, true);
});
