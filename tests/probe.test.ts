import assert from "node:assert/strict";
import { test } from "node:test";
import { runProbe } from "../src/probe.js";

test("probe 报告固定字形宽度与渲染指纹", { timeout: 30_000 }, async () => {
  const report = await runProbe({ strictFont: process.platform === "win32" });
  assert.equal(report.ok, true);
  assert.ok(report.render);
  assert.equal(report.render.renderer, "dom");
  assert.equal(report.render.cols, 80);
  assert.ok(report.render.cellWidth > 0);
  assert.ok(report.render.cellHeight > 0);
  assert.match(report.render.fingerprint, /^[0-9a-f]{16}$/u);
  assert.ok(report.glyphs.every((glyph) => glyph.pass), JSON.stringify(report.glyphs));
  assert.ok(report.fontScale);
  assert.equal(report.fontScale.texts.length, 21);
  assert.ok(report.fontScale.texts.includes("⑫"));
  assert.ok(report.fontScale.texts.includes("⑲"));
  if (process.platform === "win32") assert.equal(report.fontScale.pass, true);
});
