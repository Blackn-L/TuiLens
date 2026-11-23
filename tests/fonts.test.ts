import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createBrowserEngine, createBrowserEngineFactory, runProbe } from "../src/index.js";

function systemFont(): string | undefined {
  if (process.platform === "win32") {
    return join(process.env.WINDIR ?? "C:\\Windows", "Fonts", "consola.ttf");
  }
  if (process.platform === "linux") {
    return [
      "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
      "/usr/share/fonts/truetype/liberation/LiberationMono-Regular.ttf",
    ].find(existsSync);
  }
  return ["/System/Library/Fonts/Supplemental/Arial.ttf", "/System/Library/Fonts/Supplemental/Arial Unicode.ttf"].find(
    existsSync
  );
}

test("字体文件被嵌入页面并进入渲染指纹", { timeout: 30_000 }, async (context) => {
  const fontFile = systemFont();
  if (!fontFile || !existsSync(fontFile)) {
    context.skip("no known system font is available");
    return;
  }
  const engine = await createBrowserEngine({ cols: 12, rows: 2, onData() {}, fontFile });
  try {
    await engine.write("FONT");
    const snapshot = await engine.snapshot(1);
    assert.ok(snapshot.render);
    assert.match(snapshot.render.fontFamily, /^'TuiLensEmbeddedFont',/u);
    assert.match(snapshot.render.fontHash ?? "", /^[0-9a-f]{16}$/u);
  } finally {
    await engine.close();
  }
});

test("损坏的字体文件返回 INVALID_FONT_FILE", { timeout: 30_000 }, async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "tuilens-font-"));
  const fontFile = join(directory, "broken.ttf");
  await writeFile(fontFile, "not a font", "utf8");
  context.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5 }));
  await assert.rejects(createBrowserEngine({ cols: 12, rows: 2, onData() {}, fontFile }), {
    code: "INVALID_FONT_FILE",
  });
});

test("字体文件配合 strict probe 保持圈码字阶一致", { timeout: 60_000 }, async (context) => {
  if (process.platform !== "win32") {
    context.skip("Windows Terminal/Cascadia fallback regression is Windows-specific");
    return;
  }
  const fontFile = systemFont();
  if (!fontFile || !existsSync(fontFile)) {
    context.skip("Consolas is not available");
    return;
  }
  const report = await runProbe({ fontFile, strictFont: true });
  const baseline = await runProbe({ strictFont: true });
  assert.equal(report.ok, true);
  assert.equal(report.fontScale?.pass, true);
  assert.match(report.render?.fontHash ?? "", /^[0-9a-f]{16}$/u);
  // Consolas 明显窄于默认 fallback，可证明嵌入字体确实参与了布局而不是只留下元数据。
  assert.notEqual(report.render?.cellWidth, baseline.render?.cellWidth);
});

test("共享浏览器在字体加载失败后仍能启动后续会话", { timeout: 60_000 }, async (context) => {
  const fontFile = systemFont();
  if (!fontFile || !existsSync(fontFile)) {
    context.skip("no known system font is available");
    return;
  }
  const directory = await mkdtemp(join(tmpdir(), "tuilens-font-shared-"));
  const broken = join(directory, "broken.ttf");
  await writeFile(broken, "not a font", "utf8");
  context.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5 }));
  const factory = createBrowserEngineFactory();
  try {
    await assert.rejects(factory({ cols: 12, rows: 2, onData() {}, fontFile: broken }), { code: "INVALID_FONT_FILE" });
    const engine = await factory({ cols: 12, rows: 2, onData() {}, fontFile });
    try {
      await engine.write("OK");
      assert.equal((await engine.snapshot(1)).lines[0], "OK");
    } finally {
      await engine.close();
    }
  } finally {
    await factory.shutdown();
  }
});
