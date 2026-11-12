import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { PNG } from "pngjs";
import { createBrowserEngine } from "../src/engine/browser-engine.js";
import type { TerminalEngine } from "../src/core/types.js";

/** 统计块字符条带中明显低于中位亮度的周期暗列。 */
function darkBlockColumns(png: PNG, columns = 160, blocks = 120): number[] {
  const width = Math.round(blocks * png.width / columns);
  const luminance = (x: number, y: number): number => {
    const offset = (y * png.width + x) * 4;
    return 0.2126 * png.data[offset]! + 0.7152 * png.data[offset + 1]! + 0.0722 * png.data[offset + 2]!;
  };
  let top = png.height;
  let bottom = -1;
  for (let y = 0; y < png.height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * png.width + x) * 4;
      const r = png.data[offset]!;
      const g = png.data[offset + 1]!;
      const b = png.data[offset + 2]!;
      if (b > 80 && b > r * 1.5 && b > g * 1.2) {
        top = Math.min(top, y);
        bottom = Math.max(bottom, y);
      }
    }
  }
  if (bottom < top) return [];
  const values: number[] = [];
  for (let x = 0; x < width; x += 1) {
    let total = 0;
    for (let y = top; y <= bottom; y += 1) total += luminance(x, y);
    values.push(total / (bottom - top + 1));
  }
  const sorted = [...values].sort((left, right) => left - right);
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
  const threshold = median * 0.95;
  const minima: number[] = [];
  for (let x = 1; x < values.length - 1; x += 1) {
    if (values[x]! <= values[x - 1]! && values[x]! < values[x + 1]! && values[x]! < threshold) {
      minima.push(x);
    }
  }
  return minima;
}

test("快速文本条件读取当前解析状态，支持中文且不等待截图", async () => {
  const engine = await createBrowserEngine({ cols: 40, rows: 8, onData() {} });
  try {
    await engine.write("READY 中文 🚀");
    assert.equal(await engine.hasText?.("中文"), true);
    assert.equal(await engine.hasText?.("ABSENT"), false);
    await engine.write("\x1b[2J\x1b[HNEW");
    assert.equal(await engine.hasText?.("READY"), false);
    assert.equal(await engine.hasText?.("NEW"), true);
  } finally { await engine.close(); }
});

test("默认引擎保留 xterm 原生 DA 应答", async () => {
  const responses: string[] = [];
  const engine = await createBrowserEngine({ cols: 20, rows: 4, onData: (data) => responses.push(data) });
  try {
    await engine.write("\x1b[c\x1b[>c");
    await engine.snapshot(1);
    assert.ok(responses.includes("\x1b[?1;2c"));
    assert.ok(responses.includes("\x1b[>0;276;0c"));
  } finally { await engine.close(); }
});

test("鼠标编码与跟踪范围独立，模式镜像符合 xterm 查询响应", { timeout: 30_000 }, async () => {
  const responses: string[] = [];
  const engine = await createBrowserEngine({ cols: 20, rows: 4, onData: (data) => responses.push(data) });
  try {
    await engine.write("\x1b[?1003h");
    assert.equal((await engine.state()).modes.mouseTracking, "any");
    assert.equal((await engine.state()).modes.mouseEncoding, "legacy");
    await engine.write("\x1b[?1006h\x1b[?1006$p");
    assert.equal((await engine.state()).modes.mouseEncoding, "sgr");
    assert.ok(responses.includes("\x1b[?1006;1$y"));
    await engine.write("\x1b[?1016h\x1b[?1006$p\x1b[?1016$p");
    assert.equal((await engine.state()).modes.mouseEncoding, "sgr-pixels");
    assert.ok(responses.includes("\x1b[?1006;2$y"));
    assert.ok(responses.includes("\x1b[?1016;1$y"));
    await engine.write("\x1b[?1006l");
    assert.equal((await engine.state()).modes.mouseEncoding, "legacy");
    await engine.write("\x1b[?1006h\x1bc");
    assert.equal((await engine.state()).modes.mouseEncoding, "legacy");
    assert.equal((await engine.state()).modes.mouseTracking, "none");
  } finally {
    await engine.close();
  }
});

test("同步输出未提交时只允许轻量状态读取，观察必须明确返回 FRAME_PENDING", { timeout: 30_000 }, async () => {
  const engine = await createBrowserEngine({ cols: 20, rows: 4, onData() {} });
  try {
    await engine.write("\x1b[?25lBASE");
    const before = await engine.screenshot();
    await engine.write("\x1b[?2026h\rPENDING");
    const pending = await engine.state();
    assert.equal(pending.cols, 20);
    assert.equal(pending.rows, 4);
    assert.equal(pending.modes.synchronizedOutput, true);
    assert.equal("cells" in pending, false);
    assert.equal("text" in pending, false);
    await assert.rejects(engine.snapshot(1), { code: "FRAME_PENDING" });
    await assert.rejects(engine.screenshot(), { code: "FRAME_PENDING" });
    const pendingSnapshot = await engine.snapshot(1, { allowPendingFrame: true });
    assert.equal(pendingSnapshot.modes.synchronizedOutput, true);
    await assert.rejects(engine.snapshot(1), { code: "FRAME_PENDING" });
    // 结束序列是另一次写入；调用方必须能先结束观察再让此写入通过。
    await engine.write("\x1b[?2026l");
    assert.equal((await engine.state()).modes.synchronizedOutput, false);
    const committed = await engine.snapshot(2);
    assert.equal(committed.lines[0], "PENDING");
    const after = await engine.screenshot();
    assert.equal(before.png.equals(after.png), false);
  } finally {
    await engine.close();
  }
});

test("光标可见性、样式和闪烁进入状态与快照，截图默认隐藏", { timeout: 30_000 }, async () => {
  const engine = await createBrowserEngine({ cols: 20, rows: 4, onData() {} });
  try {
    await engine.write("\x1b[?25l\x1b[4 q");
    const hiddenState = await engine.state();
    assert.deepEqual(hiddenState.cursor, {
      x: 0, y: 0, visible: false, style: "underline", blink: false,
    });
    const hiddenSnapshot = await engine.snapshot(1);
    assert.deepEqual(hiddenSnapshot.cursor, hiddenState.cursor);

    await engine.write("\x1b[?25h\x1b[1 q\x1b[1;1HA");
    const shownState = await engine.state();
    assert.equal(shownState.cursor.visible, true);
    assert.equal(shownState.cursor.style, "block");
    assert.equal(shownState.cursor.blink, true);

    await engine.write("\x1b[2 q");
    const hidden = await engine.screenshot();
    const hiddenAgain = await engine.screenshot();
    const shown = await engine.screenshot(undefined, { cursor: "show" });
    assert.deepEqual(hidden.png, hiddenAgain.png);
    assert.notDeepEqual(hidden.png, shown.png);
  } finally { await engine.close(); }
});

test("resize 后截图直接使用新网格并保持 PNG 尺寸一致", { timeout: 30_000 }, async () => {
  const engine = await createBrowserEngine({ cols: 20, rows: 8, onData() {} });
  try {
    await engine.write("\x1b[?25l\x1b[48;2;0;255;0m\x1b[2J");
    const before = await engine.screenshot();
    await engine.resize(60, 12);
    const after = await engine.screenshot();
    const state = await engine.state();
    assert.equal(state.cols, 60);
    assert.equal(state.rows, 12);
    assert.equal(after.width, after.png.readUInt32BE(16));
    assert.equal(after.height, after.png.readUInt32BE(20));
    assert.ok(after.width > before.width);
    await engine.resize(30, 10);
    const again = await engine.screenshot();
    assert.equal(again.width, again.png.readUInt32BE(16));
    assert.equal(again.height, again.png.readUInt32BE(20));
    assert.equal((await engine.state()).cols, 30);
  } finally { await engine.close(); }
});

test("浏览器终端解析宽字符、样式与模式，并从同一画面输出 PNG", { timeout: 30_000 }, async () => {
  const responses: string[] = [];
  const engine = await createBrowserEngine({ cols: 40, rows: 8, onData: (data) => responses.push(data) });
  try {
    await engine.write("\x1b[?1049h\x1b[?2004h\x1b[?1003h\x1b[?1006h");
    await engine.write("\x1b[38;2;18;52;86m\x1b[48;2;23;58;40m\x1b[1m中A⠀🚀\x1b[0m");
    const snapshot = await engine.snapshot(17);
    assert.equal(snapshot.frameId, 17);
    assert.equal(snapshot.cols, 40);
    assert.equal(snapshot.rows, 8);
    assert.match(snapshot.text, /中A⠀🚀/u);
    assert.equal(snapshot.cells[0]?.[0]?.width, 2);
    assert.equal(snapshot.cells[0]?.[1]?.width, 0);
    assert.equal(snapshot.cells[0]?.[2]?.text, "A");
    assert.equal(snapshot.cells[0]?.[2]?.fg, "#123456");
    assert.equal(snapshot.cells[0]?.[2]?.bg, "#173a28");
    assert.equal(snapshot.cells[0]?.[2]?.bold, true);
    assert.equal(snapshot.modes.alternateScreen, true);
    assert.equal(snapshot.modes.bracketedPaste, true);
    assert.equal(snapshot.modes.mouseTracking, "any");

    await engine.write("\x1b[6n\x1b[16t");
    await engine.snapshot(18);
    assert.ok(responses.some((data) => /^\x1b\[\d+;\d+R$/.test(data)), "必须将光标查询响应交还 PTY");
    assert.ok(responses.some((data) => /^\x1b\[6;\d+;\d+t$/.test(data)), "必须返回真实字符像素尺寸");
    const image = await engine.screenshot();
    assert.deepEqual(image.png.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    assert.equal(image.png.readUInt32BE(16), image.width);
    assert.equal(image.png.readUInt32BE(20), image.height);
    assert.ok(image.png.byteLength > 1000);
    await engine.resize(60, 10);
    const resized = await engine.snapshot(19);
    assert.equal(resized.cols, 60);
    assert.equal(resized.rows, 10);
    assert.match(resized.text, /中A⠀🚀/u);
  } finally {
    await engine.close();
    await engine.close();
  }
  await assert.rejects(engine.write("late"), { code: "ENGINE_CLOSED" });
});

test("同一管理器的多个会话共享浏览器进程并按引用释放", { timeout: 60_000 }, async () => {
  const { createBrowserEngineFactory } = await import("../src/engine/browser-engine.js");
  const factory = createBrowserEngineFactory();
  const first = await factory({ cols: 20, rows: 4, onData() {} });
  const second = await factory({ cols: 20, rows: 4, onData() {} });
  try {
    await first.write("FIRST");
    await second.write("SECOND");
    // 两个会话各自独立解析，不能串屏。
    assert.equal((await first.snapshot(1)).lines[0], "FIRST");
    assert.equal((await second.snapshot(1)).lines[0], "SECOND");
    await first.close();
    // 关闭一个会话不影响另一个。
    assert.equal((await second.snapshot(2)).lines[0], "SECOND");
  } finally {
    await second.close();
    await factory.shutdown();
  }
  // 显式 shutdown 后拒绝新引擎。
  await assert.rejects(factory({ cols: 20, rows: 4, onData() {} }), { code: "ENGINE_CLOSED" });
});

test("会话上限可配置，默认值仍为 8", async () => {
  const { SessionManager } = await import("../src/session/manager.js");
  const limited = new SessionManager({ artifactDir: tmpdir(), maxSessions: 1 });
  try {
    assert.throws(() => new SessionManager({ artifactDir: tmpdir(), maxSessions: 0 }),
      { code: "INVALID_ARGUMENT" });
    // 上限 1：第二次启动在创建引擎前就被拒绝，因此不需要真实浏览器。
    const engine: TerminalEngine = {
      write: async () => {}, state: async () => ({
        cols: 10, rows: 2, cursor: { x: 0, y: 0, visible: true, style: "block", blink: false },
        modes: { alternateScreen: false, bracketedPaste: false, applicationCursorKeys: false, mouseTracking: "none" },
      }),
      snapshot: async (id) => ({ frameId: id, capturedAt: "", cols: 10, rows: 2, text: "", lines: [], cells: [],
        cursor: { x: 0, y: 0, visible: true, style: "block", blink: false },
        modes: { alternateScreen: false, bracketedPaste: false, applicationCursorKeys: false, mouseTracking: "none" } }),
      screenshot: async () => ({ png: Buffer.alloc(0), width: 1, height: 1 }),
      resize: async () => {}, close: async () => {},
    };
    const manager = new SessionManager({ artifactDir: tmpdir(), maxSessions: 1, engineFactory: async () => engine });
    try {
      await manager.launch({ command: process.execPath, args: ["-e", "setTimeout(()=>{},5000)"] });
      await assert.rejects(
        manager.launch({ command: process.execPath, args: ["-e", "setTimeout(()=>{},5000)"] }),
        (error: unknown) => error instanceof Error && "code" in error && error.code === "SESSION_LIMIT"
          && (error as { details?: { maxSessions?: number } }).details?.maxSessions === 1);
    } finally { await manager.closeAll(); }
  } finally { await limited.closeAll().catch(() => undefined); }
});

test("默认 DOM；显式 WebGL 的 120 个块字符不产生周期暗列", { timeout: 30_000 }, async () => {
  const dom = await createBrowserEngine({ cols: 40, rows: 8, onData() {} });
  try {
    assert.equal(dom.renderer, "dom");
  } finally {
    await dom.close();
  }

  const engine = await createBrowserEngine({ cols: 160, rows: 8, renderer: "webgl", onData() {} });
  try {
    assert.equal(engine.renderer, "webgl");
    await engine.write(`\x1b[?25l\x1b[38;2;0;120;255m${"▄".repeat(120)}\x1b[0m`);
    const png = PNG.sync.read((await engine.screenshot()).png);
    assert.deepEqual(darkBlockColumns(png), [], "WebGL 块字符条带不应出现 9/10px 周期暗列");
  } finally {
    await engine.close();
  }
});
