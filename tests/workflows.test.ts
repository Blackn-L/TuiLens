import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { SessionManager } from "../src/session/manager.js";
import { RecordingWriter } from "../src/recording/writer.js";
import { replayRecording } from "../src/recording/replay.js";

const fixture = fileURLToPath(new URL("./fixtures/sample-tui.js", import.meta.url));
test("真实终端：区域截图、比较、精确定位、过期保护、输入与离线回放", { timeout: 60000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "tuilens-workflow-"));
  const manager = new SessionManager({ artifactDir: directory });
  try {
    const session = await manager.launch({ command: process.execPath, args: [fixture], cols: 40, rows: 10, recording: {} });
    await manager.wait(session.id, { conditions: [{ kind: "text", text: "READY" }, { kind: "text", text: "COLLAPSE" }] });
    await assert.rejects(manager.find(session.id, "Run", undefined, undefined, { selection: "unique" }), { code: "AMBIGUOUS_MATCH" });
    const matches = await manager.find(session.id, "Run", undefined, undefined, { style: { bold: true }, selection: "unique" });
    assert.equal(matches.length, 1);
    assert.equal(matches[0]?.region.x, 6);
    await manager.clickText(session.id, "Run", undefined, { nth: 1 });
    const region = { x: 0, y: 0, width: 15, height: 4 };
    const before = await manager.observe(session.id, { region });
    const full = await manager.observe(session.id);
    assert.ok(before.screenshot!.width < full.screenshot!.width);
    assert.ok(before.screenshot!.height < full.screenshot!.height);
    assert.equal((await manager.compare(session.id, { baseline: before.screenshot!.path, region })).pass, true);
    await manager.input(session.id, { type: "text", text: "g" }, { frameId: before.snapshot.frameId });
    await manager.wait(session.id, { conditions: [{ kind: "text", text: "UPDATED" }], afterFrameId: before.snapshot.frameId });
    await assert.rejects(manager.input(session.id, { type: "key", key: "Enter" }, { frameId: before.snapshot.frameId }), { code: "STALE_FRAME" });
    // 顶部文字改变不影响第二行按钮的区域指纹。
    await manager.input(session.id, { type: "click", x: 7, y: 1 },
      { region: { bounds: matches[0]!.region, fingerprint: matches[0]!.fingerprint! } });
    await manager.clickText(session.id, "COLLAPSE", undefined, { hitbox: { right: 8 }, point: "right" });
    await manager.wait(session.id, { conditions: [{ kind: "text", text: "COLLAPSED" }] });
    const changed = await manager.compare(session.id, { baseline: before.screenshot!.path, region });
    assert.equal(changed.pass, false);
    assert.ok(changed.differentPixels > 0);
    assert.ok((await stat(changed.diff)).size > 0);
    await manager.input(session.id, { type: "drag", from: { x: 1, y: 2 }, to: { x: 14, y: 2 }, modifiers: { shift: true } });
    await manager.wait(session.id, { conditions: [{ kind: "text", text: "DRAG_RECEIVED" }] });
    await manager.input(session.id, { type: "paste", text: "你好\n🚀" });
    await manager.wait(session.id, { conditions: [{ kind: "text", text: "PASTE_RECEIVED" }] });
    await manager.resize(session.id, 50, 12);
    await manager.wait(session.id, { conditions: [{ kind: "text", text: "SIZE_50_12" }] });
    await manager.input(session.id, { type: "key", key: "Ctrl+q" });
    const final = await manager.wait(session.id, { conditions: [{ kind: "exited" }] });
    const replay = await manager.replay(session.recordingPath!);
    assert.equal(replay.snapshot.text, final.observation.snapshot.text);
    assert.match(replay.snapshot.text, /RECORD_FINAL/);
    assert.equal(replay.snapshot.cols, 50);
    assert.equal(replay.truncated, false);
    const recording = await readFile(session.recordingPath!, "utf8");
    assert.ok(recording.includes('"type":"input"'));
    assert.ok(!recording.includes('"env"'));
  } finally { await manager.closeAll(); await rm(directory, { recursive: true, force: true, maxRetries: 5 }); }
});

test("录制容量上限被明确标记，不会作为完整回放通过", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tuilens-recording-"));
  try {
    const writer = await RecordingWriter.create(directory, "cap", { type: "header", version: 1, cols: 40, rows: 10, images: "off" }, 4096);
    await writer.append({ type: "output", data: "x".repeat(5000) });
    await writer.close();
    assert.ok((await stat(writer.path)).size <= 4096);
    await assert.rejects(replayRecording(writer.path, { artifactDir: directory }), { code: "TRUNCATED_RECORDING" });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("场景执行保留失败证据，成功和失败都关闭会话", { timeout: 30000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "tuilens-scenario-"));
  const manager = new SessionManager({ artifactDir: directory });
  try {
    const launch = { command: process.execPath, args: [fixture], cols: 40, rows: 10 };
    const passed = await manager.scenario({ version: 1, launch, steps: [
      { type: "wait", conditions: [{ kind: "text", text: "READY" }] },
      { type: "input", action: { type: "text", text: "g" } },
      { type: "wait", conditions: [{ kind: "text", text: "UPDATED" }] },
      { type: "observe", region: { x: 0, y: 0, width: 15, height: 4 } },
    ] });
    assert.equal(passed.pass, true);
    assert.deepEqual(manager.list(), []);
    const failed = await manager.scenario({ version: 1, launch, steps: [
      { type: "wait", conditions: [{ kind: "text", text: "READY" }] },
      { type: "wait", conditions: [{ kind: "text", text: "NEVER_THERE" }], timeoutMs: 200 },
    ] });
    assert.equal(failed.pass, false);
    assert.ok(failed.failureScreenshot);
    assert.ok((await stat(failed.reportPath)).size > 0);
    assert.deepEqual(manager.list(), []);
  } finally { await manager.closeAll(); await rm(directory, { recursive: true, force: true, maxRetries: 5 }); }
});

test("观察可以读取视口上方的回滚行，用于断言已滚出屏幕的历史", { timeout: 60_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "tuilens-scrollback-"));
  const manager = new SessionManager({ artifactDir: directory });
  // 持续输出，把早期内容推出视口。
  const script = ["-e", String.raw`
let n = 0;
const tick = () => {
  n += 1;
  process.stdout.write("HISTORY_" + n + "\r\n");
  if (n < 60) setTimeout(tick, 5);
  else process.stdout.write("SCROLL_DONE\r\n");
};
tick();
`];
  try {
    const session = await manager.launch({ command: process.execPath, args: script, cols: 40, rows: 6 });
    await manager.wait(session.id, { conditions: [{ kind: "text", text: "SCROLL_DONE" }], timeoutMs: 30000 });
    const view = await manager.observe(session.id, { screenshot: false, cells: false });
    // 早期内容已经离开视口。
    assert.equal(view.snapshot.text.includes("HISTORY_1"), false);
    const withHistory = await manager.observe(session.id, {
      screenshot: false, cells: false, scrollback: 200,
    });
    assert.ok(withHistory.snapshot.scrollback);
    assert.ok(withHistory.snapshot.scrollback!.some((line) => line.includes("HISTORY_1")));
    // 回滚内容从旧到新排列，最后一行应早于视口。
    const joined = withHistory.snapshot.scrollback!.join("\n");
    assert.ok(joined.indexOf("HISTORY_1") < joined.indexOf("HISTORY_50"));
    // 请求行数少于可用行数时不应被标记为截断。
    const small = await manager.observe(session.id, { screenshot: false, cells: false, scrollback: 5 });
    assert.equal(small.snapshot.scrollback!.length, 5);
    assert.equal(small.snapshot.scrollbackTruncated, undefined);
  } finally { await manager.closeAll(); await rm(directory, { recursive: true, force: true, maxRetries: 5 }); }
});
