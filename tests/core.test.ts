import assert from "node:assert/strict";
import test from "node:test";
import { encodeInput, encodeKey } from "../src/core/input.js";
import { findText, regionFingerprint } from "../src/core/locator.js";
import { methodSchemas } from "../src/core/protocol.js";
import { TuiLensError } from "../src/core/errors.js";
import { clickTextOptions, launchOptions, waitOptions } from "../src/core/validation.js";
import type { TerminalCell, TerminalSnapshot } from "../src/core/types.js";

function cell(x: number, text: string, width = 1): TerminalCell {
  return { x, y: 0, text, width, fg: "#ffffff", bg: "#000000",
    bold: false, italic: false, underline: false, inverse: false };
}

const snapshot: TerminalSnapshot = {
  frameId: 1, capturedAt: "2026-01-01", cols: 10, rows: 2,
  text: "A中🚀éB", lines: ["A中🚀éB", ""],
  cells: [
    [cell(0, "A"), cell(1, "中", 2), cell(2, "", 0),
      cell(3, "🚀", 2), cell(4, "", 0), cell(5, "é"), cell(6, "B"),
      cell(7, " "), cell(8, " "), cell(9, " ")],
    [],
  ],
  cursor: { x: 7, y: 0, visible: true, style: "block", blink: false },
  modes: { alternateScreen: false, bracketedPaste: true, applicationCursorKeys: false, mouseTracking: "any", mouseEncoding: "sgr" },
};

test("字符格定位正确映射中文、emoji、组合字素", () => {
  assert.deepEqual(findText(snapshot, "中🚀é")[0]?.region,
    { x: 1, y: 0, width: 5, height: 1 });
  assert.deepEqual(findText(snapshot, "B")[0]?.region,
    { x: 6, y: 0, width: 1, height: 1 });
  assert.equal(findText(snapshot, "中", { x: 2, y: 0, width: 3, height: 1 }).length, 0);
  assert.equal(findText(snapshot, "中", { x: 1, y: 0, width: 1, height: 1 }).length, 0);
});

test("局部稳定判断不受外部行与 frameId 影响，但捕获样式变化", () => {
  const region = { x: 0, y: 0, width: 3, height: 1 };
  assert.match(regionFingerprint(snapshot, region), /^[0-9a-f]{64}$/);
  const changed = structuredClone(snapshot);
  changed.frameId = 100;
  changed.cells[1] = [cell(0, "外部变化")];
  assert.equal(regionFingerprint(snapshot, region), regionFingerprint(changed, region));
  changed.cells[0]![1]!.bg = "#ff0000";
  assert.notEqual(regionFingerprint(snapshot, region), regionFingerprint(changed, region));
});

test("滚轮使用目标格坐标，不依赖之前的鼠标移动", () => {
  assert.equal(encodeInput({ type: "scroll", x: 7, y: 1, direction: "down", amount: 2 }, snapshot),
    "\x1b[<65;8;2M\x1b[<65;8;2M");
  assert.throws(() => encodeInput({ type: "click", x: 10, y: 1 }, snapshot), /x 必须/u);
  assert.throws(() => encodeInput({ type: "move", x: 1, y: 1 },
    { ...snapshot, modes: { ...snapshot.modes, mouseTracking: "none" } }), /鼠标跟踪/u);
  assert.throws(() => encodeInput({ type: "click", x: 1, y: 1 },
    { ...snapshot, modes: { ...snapshot.modes, mouseEncoding: "legacy" } }), /SGR/u);
  assert.throws(() => encodeInput({ type: "click", x: 1, y: 1 },
    { ...snapshot, modes: { ...snapshot.modes, mouseEncoding: "sgr-pixels" } }), /SGR/u);
});

test("多行粘贴保留数据，拒绝未协商和 ESC 逃逸", () => {
  assert.equal(encodeInput({ type: "paste", text: "第一行\n🚀 second" }, snapshot),
    "\x1b[200~第一行\n🚀 second\x1b[201~");
  assert.throws(() => encodeInput({ type: "paste", text: "x\x1b[201~" }, snapshot), /ESC/u);
  assert.throws(() => encodeInput({ type: "paste", text: "x" },
    { ...snapshot, modes: { ...snapshot.modes, bracketedPaste: false } }), /括号粘贴/u);
  assert.throws(() => encodeInput({ type: "text", text: "one\ntwo" }, snapshot), /控制字符/u);
});

test("按键编码跟随应用光标模式与明确组合", () => {
  assert.equal(encodeKey("ArrowUp", false), "\x1b[A");
  assert.equal(encodeKey("ArrowUp", true), "\x1bOA");
  assert.equal(encodeKey("Ctrl+Right", true), "\x1b[1;5C");
  assert.equal(encodeKey("Ctrl+q", false), "\x11");
  assert.equal(encodeKey("Alt+x", false), "\x1bx");
  assert.equal(encodeKey("Shift+Tab", false), "\x1b[Z");
  assert.throws(() => encodeKey("Meta+Foo", false), /不支持/u);
});

test("0.4 新契约严格校验启动应答、点击命中区和光标等待", () => {
  for (const colorMode of ["truecolor", "ansi256", "none"] as const) {
    assert.equal(methodSchemas.launch.safeParse({ command: "node", colorMode }).success, true);
    launchOptions({ command: "node", colorMode });
  }
  launchOptions({ command: "node", protocolReplies: { mode: "auto", maxLatencyMs: 250 } });
  clickTextOptions({ hitbox: { left: 1, right: 3, top: 0, bottom: 0 }, point: "right",
    offset: { x: -1, y: 0 }, button: "left" });
  waitOptions({ conditions: [{ kind: "cursor", visible: true, style: "bar" }] });
  assert.equal(methodSchemas.inputAndWait.safeParse({
    id: "00000000-0000-4000-8000-000000000000",
    action: { type: "text", text: "PING" },
    wait: { conditions: [{ kind: "text", text: "PONG" }], timeoutMs: 3000 },
  }).success, true);
  assert.throws(() => launchOptions({ command: "node", protocolReplies: { mode: "late" as "auto" } }),
    { code: "INVALID_ARGUMENT" });
  assert.throws(() => launchOptions({ command: "node", colorMode: 256 as unknown as "ansi256" }),
    (error: unknown) => error instanceof TuiLensError && error.code === "INVALID_ARGUMENT"
      && (error.details as { received?: unknown }).received === 256);
  assert.throws(() => clickTextOptions({ hitbox: { left: -1 } }), { code: "INVALID_ARGUMENT" });
  assert.throws(() => clickTextOptions({ allowPendingFrame: "yes" as unknown as boolean }), { code: "INVALID_ARGUMENT" });
  assert.equal(methodSchemas.clickText.safeParse({ id: "00000000-0000-4000-8000-000000000000",
    text: "Run", options: { allowPendingFrame: true } }).success, true);
  assert.throws(() => waitOptions({ conditions: [{ kind: "cursor" }] }), { code: "INVALID_ARGUMENT" });
  assert.equal(methodSchemas.wait.safeParse({
    id: "00000000-0000-4000-8000-000000000000",
    conditions: [{ kind: "cursor" }],
  }).success, false);
});

test("翻页和首尾导航使用独立滚轮契约，不突破单次事件上限", () => {
  const action = { type: "scroll", x: 7, y: 1, direction: "down", unit: "page" } as const;
  assert.equal(encodeInput(action, snapshot), "\x1b[<65;8;2M".repeat(6));
  assert.equal(methodSchemas.input.safeParse({ id: "00000000-0000-4000-8000-000000000000",
    action: { ...action, amount: 3 } }).success, true);
  assert.equal(encodeInput({ type: "scroll", x: 7, y: 1, to: "bottom" }, snapshot),
    "\x1b[<65;8;2M".repeat(2000));
  assert.equal(encodeInput({ type: "scroll", x: 7, y: 1, to: "top" }, snapshot),
    "\x1b[<64;8;2M".repeat(2000));
  assert.throws(() => encodeInput({ ...action, amount: 101 }, snapshot), { code: "INVALID_ARGUMENT" });
  assert.equal(methodSchemas.input.safeParse({ id: "00000000-0000-4000-8000-000000000000",
    action: { type: "scroll", x: 7, y: 1, to: "top", amount: 3 } }).success, false);
});
