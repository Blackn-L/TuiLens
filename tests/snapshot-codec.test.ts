import assert from "node:assert/strict";
import { test } from "node:test";
import { unpackGrid } from "../src/engine/snapshot-codec.js";
import { createBrowserEngine } from "../src/engine/browser-engine.js";

test("压缩网格精确还原宽字符、续格、颜色与样式", () => {
  // 3 列 1 行：宽字符 (宽 2) + 续格 0 宽 + 普通字符。
  const packed = {
    text: "T中\u001fc\u001ftA",
    style: "2,ffffff,000000,0;1,ff0000,00ff00,f;",
  };
  const cells = unpackGrid(packed, 3, 1);
  assert.equal(cells.length, 1);
  assert.deepEqual(cells[0]!.map((cell) => [cell.x, cell.text, cell.width]), [
    [0, "中", 2], [1, "", 0], [2, "A", 1],
  ]);
  assert.equal(cells[0]![0]!.fg, "#ffffff");
  assert.equal(cells[0]![2]!.fg, "#ff0000");
  assert.equal(cells[0]![2]!.bg, "#00ff00");
  // flags f = 1|2|4|8
  assert.equal(cells[0]![2]!.bold, true);
  assert.equal(cells[0]![2]!.italic, true);
  assert.equal(cells[0]![2]!.underline, true);
  assert.equal(cells[0]![2]!.inverse, true);
  assert.equal(cells[0]![0]!.bold, false);
});

test("压缩网格游程展开与空格/空字符格", () => {
  const cells = unpackGrid({ text: "s3\u001fe2\u001ftX", style: "6,111111,222222,0;" }, 6, 1);
  assert.deepEqual(cells[0]!.map((cell) => cell.text), [" ", " ", " ", "", "", "X"]);
  assert.ok(cells[0]!.every((cell) => cell.fg === "#111111"));
});

test("压缩网格拒绝行数、列数与样式覆盖不一致的载荷", () => {
  assert.throws(() => unpackGrid({ text: "tA\n", style: "1,000000,000000,0;\n" }, 1, 1),
    { code: "INVALID_SNAPSHOT" });
  assert.throws(() => unpackGrid({ text: "tA", style: "1,000000,000000,0;" }, 2, 1),
    { code: "INVALID_SNAPSHOT" });
  // 两个字符格但样式只覆盖一个：不能静默补默认样式。
  assert.throws(() => unpackGrid({ text: "tA\u001ftB", style: "1,000000,000000,0;" }, 2, 1),
    { code: "INVALID_SNAPSHOT" });
  assert.throws(() => unpackGrid({ text: "z", style: "1,000000,000000,0;" }, 1, 1),
    { code: "INVALID_SNAPSHOT" });
});

test("引擎快照与压缩载荷往返一致，且可跳过字符网格", { timeout: 30_000 }, async () => {
  const engine = await createBrowserEngine({ cols: 20, rows: 4, onData() {} });
  try {
    await engine.write("\x1b[?25l\x1b[38;2;18;52;86m\x1b[48;2;23;58;40m\x1b[1m中A⠀🚀\x1b[0m  ");
    const full = await engine.snapshot(1);
    assert.equal(full.cells[0]?.[0]?.width, 2);
    assert.equal(full.cells[0]?.[1]?.width, 0);
    assert.equal(full.cells[0]?.[2]?.text, "A");
    assert.equal(full.cells[0]?.[2]?.fg, "#123456");
    assert.equal(full.cells[0]?.[2]?.bg, "#173a28");
    assert.equal(full.cells[0]?.[2]?.bold, true);
    // 尾部的两个空格在关闭样式后写入；xterm 仍可能把它合并为默认样式的空格格。
    assert.equal(full.cells[0]?.length, 20);
    assert.match(full.text, /中A⠀🚀/u);

    const light = await engine.snapshot(1, { cells: false });
    assert.deepEqual(light.cells, []);
    assert.equal(light.text, full.text);
    assert.deepEqual(light.lines, full.lines);
    assert.deepEqual(light.cursor, full.cursor);
    assert.deepEqual(light.modes, full.modes);
  } finally { await engine.close(); }
});
