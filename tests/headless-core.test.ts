import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { BrowserEngineOptions, TerminalEngine, TerminalSnapshot } from "../src/core/types.js";
import { createBrowserEngine, type VisualEngineFactory } from "../src/engine/browser-engine.js";
import { createHeadlessEngine } from "../src/engine/headless-core.js";

interface VisualCall {
  type: "write" | "resize";
  value: string | number;
}

function fakeVisual(optionsSeen: BrowserEngineOptions[]) {
  const calls: VisualCall[] = [];
  let closes = 0;
  const engine: TerminalEngine = {
    renderer: "dom",
    async write(data) {
      calls.push({ type: "write", value: data });
    },
    async resize(cols) {
      calls.push({ type: "resize", value: cols });
    },
    async state() {
      return {
        cols: 1,
        rows: 1,
        cursor: { x: 0, y: 0, visible: true, style: "block", blink: false },
        modes: { alternateScreen: false, bracketedPaste: false, applicationCursorKeys: false, mouseTracking: "none" },
      };
    },
    async snapshot(frameId): Promise<TerminalSnapshot> {
      return {
        frameId,
        capturedAt: "",
        cols: 1,
        rows: 1,
        text: "",
        lines: [""],
        cells: [],
        cursor: { x: 0, y: 0, visible: true, style: "block", blink: false },
        modes: { alternateScreen: false, bracketedPaste: false, applicationCursorKeys: false, mouseTracking: "none" },
      };
    },
    async screenshot() {
      return { png: Buffer.from([137, 80, 78, 71]), width: 1, height: 1 };
    },
    async paint() {
      return { paintMs: 1 };
    },
    async close() {
      closes += 1;
    },
  };
  const factory = ((options: BrowserEngineOptions) => {
    optionsSeen.push(options);
    return Promise.resolve(engine);
  }) as VisualEngineFactory;
  factory.shutdown = async () => {};
  return {
    factory,
    calls,
    closes: () => closes,
  };
}

test("纯文本会话不创建 VisualRenderer，并保持键盘/鼠标/回滚语义", async () => {
  const optionsSeen: BrowserEngineOptions[] = [];
  const visual = fakeVisual(optionsSeen);
  const engine = await createBrowserEngine(
    { cols: 20, rows: 5, onData() {}, maxVisualReplayBytes: 64 },
    visual.factory
  );
  try {
    assert.equal(engine.renderer, "headless");
    await engine.write("READY 中文");
    assert.equal(await engine.hasText?.("中文"), true);
    const probe = await engine.probeText?.("中文");
    assert.equal(probe?.count, 1);
    assert.deepEqual(probe?.matches[0]?.region, { x: 6, y: 0, width: 4, height: 1 });

    await engine.write("\x1b[>1u\x1b[?1002h\x1b[?1006h\x1b[?25l\x1b[4 q");
    const state = await engine.state();
    assert.equal(state.modes.keyboard?.kitty, 1);
    assert.equal(state.modes.mouseTracking, "drag");
    assert.equal(state.modes.mouseEncoding, "sgr");
    assert.deepEqual(state.cursor, { x: 10, y: 0, visible: false, style: "underline", blink: false });

    await engine.write("\x1b[2J\x1b[Hone\r\ntwo\r\nthree\r\nfour\r\nfive\r\nsix\r\nseven");
    const snapshot = await engine.snapshot(1, { scrollback: 5 });
    assert.match(snapshot.text, /five/u);
    assert.ok((snapshot.scrollback?.length ?? 0) > 0);
    assert.ok(snapshot.cells.some((row) => row[0]?.text === "f"));
    assert.equal(snapshot.render, undefined);
    assert.equal(optionsSeen.length, 0, "纯文本路径不能构造或启动可视化层");
    assert.equal(visual.closes(), 0);
  } finally {
    await engine.close();
  }
});

test("首次截图按需挂载并重放历史输出与 resize，之后继续双写", async () => {
  const optionsSeen: BrowserEngineOptions[] = [];
  const visual = fakeVisual(optionsSeen);
  const engine = await createBrowserEngine({ cols: 5, rows: 2, onData() {} }, visual.factory);
  try {
    await engine.write("ABCDEF");
    await engine.resize(6, 3);
    await engine.write("BB");
    const capture = await engine.screenshot();
    assert.equal(capture.width, 1);
    assert.equal(optionsSeen.length, 1);
    assert.equal(optionsSeen[0]?.cols, 6);
    assert.equal(optionsSeen[0]?.rows, 3);
    assert.deepEqual(visual.calls, [
      { type: "resize", value: 5 },
      { type: "write", value: "ABCDEF" },
      { type: "resize", value: 6 },
      { type: "write", value: "BB" },
    ]);
    assert.equal(engine.renderer, "dom");
    assert.equal(engine.visualSyncDegraded, false);
    await engine.write("C");
    assert.deepEqual(visual.calls.at(-1), { type: "write", value: "C" });
    await engine.screenshot();
    assert.equal(optionsSeen.length, 1, "可视化层只能挂载一次");
  } finally {
    await engine.close();
  }
  assert.equal(visual.closes(), 1);
});

test("历史回放超限时明确标记 visualSyncDegraded", async () => {
  const optionsSeen: BrowserEngineOptions[] = [];
  const visual = fakeVisual(optionsSeen);
  const engine = await createBrowserEngine({ cols: 20, rows: 4, onData() {}, maxVisualReplayBytes: 8 }, visual.factory);
  try {
    await engine.write("123456789");
    assert.equal(engine.visualSyncDegraded, false);
    await engine.screenshot();
    assert.equal(engine.visualSyncDegraded, true);
    assert.deepEqual(visual.calls, [{ type: "resize", value: 20 }]);
  } finally {
    await engine.close();
  }
});

test("createHeadlessEngine 应用默认终端 profile 的应答", async () => {
  const responses: string[] = [];
  const engine = await createHeadlessEngine({ cols: 20, rows: 4, onData: (data) => responses.push(data) });
  try {
    await engine.write("\x1b[>0q");
    assert.ok(responses.includes("\x1bP>|XTerm(276)\x1b\\"));
  } finally {
    await engine.close();
  }
});

test("导入组合引擎与公共入口不会加载 Playwright", () => {
  const probe = fileURLToPath(new URL("./fixtures/module-load-probe.js", import.meta.url));
  for (const relative of ["../src/engine/browser-engine.js", "../src/index.js"]) {
    const entry = fileURLToPath(new URL(relative, import.meta.url));
    const result = spawnSync(process.execPath, [probe, entry], {
      cwd: process.cwd(),
      encoding: "utf8",
      windowsHide: true,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout) as { playwrightLoaded: boolean };
    assert.equal(output.playwrightLoaded, false, relative);
  }
});

test("非法 renderer 在创建可视化工厂前被拒绝", async () => {
  const options = {
    cols: 20,
    rows: 4,
    renderer: "bogus",
    onData() {},
  } as unknown as BrowserEngineOptions;
  let factoryCalls = 0;
  const visual = fakeVisual([]);
  const factory = ((candidate: BrowserEngineOptions) => {
    factoryCalls += 1;
    return visual.factory(candidate);
  }) as VisualEngineFactory;
  factory.shutdown = visual.factory.shutdown;
  await assert.rejects(createBrowserEngine(options, factory), { code: "INVALID_ARGUMENT" });
  assert.equal(factoryCalls, 0);
});
