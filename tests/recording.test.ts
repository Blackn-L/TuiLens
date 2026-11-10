import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import test from "node:test";
import { replayRecording } from "../src/recording/replay.js";
import { RecordingWriter } from "../src/recording/writer.js";
import type { EngineFactory, TerminalEngine, TerminalSnapshot } from "../src/core/types.js";

const header = { type: "header", version: 1, cols: 10, rows: 2, images: "off" } as const;
function snapshot(frameId: number): TerminalSnapshot {
  return { frameId, capturedAt: "now", cols: 10, rows: 2, text: "REPLAY", lines: ["REPLAY"],
    cells: [], cursor: { x: 0, y: 0, visible: true, style: "block", blink: false },
    modes: { alternateScreen: false, bracketedPaste: false, applicationCursorKeys: false, mouseTracking: "none" } };
}

function fake(overrides: Partial<TerminalEngine> = {}) {
  const calls = { close: 0, screenshot: 0, write: [] as string[], resize: [] as number[][] };
  const engine: TerminalEngine = {
    write: async (data) => { calls.write.push(data); },
    resize: async (cols, rows) => { calls.resize.push([cols, rows]); },
    state: async () => snapshot(0),
    snapshot: async (frameId) => snapshot(frameId),
    screenshot: async () => { calls.screenshot += 1; return { png: Buffer.from("PNG fixture"), width: 10, height: 2 }; },
    close: async () => { calls.close += 1; },
    ...overrides,
  };
  return { engine, calls };
}

async function recording(directory: string, events: unknown[]) {
  const file = join(directory, "input.jsonl");
  await writeFile(file, [header, ...events].map((item) => JSON.stringify(item)).join("\n") + "\n");
  return file;
}

test("录制标记截断并在并发 append 与 close 时保留合法顺序", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tuilens-record-order-"));
  try {
    const writer = await RecordingWriter.create(directory, "order", header, 4096);
    const first = writer.append({ type: "output", data: "first" });
    const second = writer.append({ type: "resize", cols: 12, rows: 3 });
    await Promise.all([first, second, writer.close(), writer.close()]);
    const records = (await readFile(writer.path, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { type: string; truncated?: boolean });
    assert.deepEqual(records.map((item) => item.type), ["header", "output", "resize", "end"]);
    assert.equal(records.at(-1)?.truncated, false);
    const dropped = await RecordingWriter.create(directory, "truncated", header, 4096);
    dropped.markTruncated();
    await dropped.close();
    const file = await readFile(dropped.path, "utf8");
    assert.match(file, /"truncated":true/u);
    await assert.rejects(replayRecording(dropped.path, { artifactDir: directory }), { code: "TRUNCATED_RECORDING" });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("录制容量参数与大小上限拒绝超限数据", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tuilens-record-cap-"));
  try {
    await assert.rejects(RecordingWriter.create(directory, "small", header, 1024), { code: "INVALID_RECORDING_LIMIT" });
    await assert.rejects(RecordingWriter.create(directory, "large", header, 65 * 1024 * 1024), { code: "INVALID_RECORDING_LIMIT" });
    const writer = await RecordingWriter.create(directory, "cap", header, 4096);
    await writer.append({ type: "output", data: "x".repeat(5000) });
    await writer.close();
    assert.ok((await stat(writer.path)).size <= 4096);
    await assert.rejects(replayRecording(writer.path, { artifactDir: directory }), { code: "TRUNCATED_RECORDING" });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("无结尾、提前结尾、乱序和事件超限在创建引擎前拒绝", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tuilens-record-invalid-"));
  let engines = 0;
  const engineFactory: EngineFactory = async () => { engines += 1; return fake().engine; };
  const manager = { artifactDir: directory, engineFactory };
  try {
    const cases: [unknown[], string][] = [
      [[{ type: "output", data: "x", atMs: 1 }], "INCOMPLETE_RECORDING"],
      [[{ type: "end", truncated: false, atMs: 1 }, { type: "output", data: "x", atMs: 2 },
        { type: "end", truncated: false, atMs: 3 }], "INVALID_RECORDING"],
      [[{ type: "output", data: "x", atMs: 3 }, { type: "end", truncated: false, atMs: 2 }], "INVALID_RECORDING"],
      [[...Array.from({ length: 100000 }, () => ({ type: "output", data: "", atMs: 0 })),
        { type: "end", truncated: false, atMs: 1 }], "RECORDING_EVENT_LIMIT"],
    ];
    for (const [events, code] of cases) {
      await assert.rejects(replayRecording(await recording(directory, events), manager), { code });
    }
    assert.equal(engines, 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("回放应用输出和 resize，但不会执行录制输入", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tuilens-replay-safe-"));
  const memory = fake();
  try {
    const path = await recording(directory, [
      { type: "output", data: "first", atMs: 1 },
      { type: "input", action: { type: "raw", data: "never execute" }, atMs: 2 },
      { type: "resize", cols: 20, rows: 4, atMs: 3 },
      { type: "output", data: "last", atMs: 4 },
      { type: "end", truncated: true, atMs: 5 },
    ]);
    const result = await replayRecording(path, { artifactDir: directory, engineFactory: async () => memory.engine },
      { allowTruncated: true });
    assert.deepEqual(memory.calls.write, ["first", "last"]);
    assert.deepEqual(memory.calls.resize, [[20, 4]]);
    assert.equal(result.snapshot.frameId, 3);
    assert.equal(result.truncated, true);
    assert.equal(memory.calls.close, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("快照内取消不会继续截图或写出成功产物", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tuilens-replay-snapshot-abort-"));
  const controller = new AbortController();
  const memory = fake({ snapshot: async (frameId) => { controller.abort(); return snapshot(frameId); } });
  try {
    const path = await recording(directory, [{ type: "end", truncated: false, atMs: 0 }]);
    await assert.rejects(replayRecording(path,
      { artifactDir: directory, engineFactory: async () => memory.engine }, { signal: controller.signal }), { code: "ABORTED" });
    assert.equal(memory.calls.screenshot, 0);
    assert.equal(memory.calls.close, 1);
    assert.deepEqual(await readdir(directory), ["input.jsonl"]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("写入悬挂时取消主动关闭引擎并有界返回", { timeout: 5000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "tuilens-replay-write-abort-"));
  const controller = new AbortController();
  let resolveStarted!: () => void;
  const started = new Promise<void>((resolve) => { resolveStarted = resolve; });
  const memory = fake({ write: () => { resolveStarted(); return new Promise<void>(() => {}); } });
  try {
    const path = await recording(directory, [
      { type: "output", data: "blocked", atMs: 0 }, { type: "end", truncated: false, atMs: 0 },
    ]);
    const replay = replayRecording(path, { artifactDir: directory, engineFactory: async () => memory.engine },
      { signal: controller.signal });
    const rejected = assert.rejects(replay, { code: "ABORTED" });
    await started;
    controller.abort();
    await rejected;
    assert.equal(memory.calls.close, 1);
    assert.equal(memory.calls.screenshot, 0);
    assert.deepEqual(await readdir(directory), ["input.jsonl"]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("计时回放等待取消统一为 ABORTED", { timeout: 5000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "tuilens-replay-delay-abort-"));
  const controller = new AbortController();
  const memory = fake();
  try {
    const path = await recording(directory, [
      { type: "output", data: "not yet", atMs: 2000 }, { type: "end", truncated: false, atMs: 2001 },
    ]);
    let ready!: () => void;
    const started = new Promise<void>((resolve) => { ready = resolve; });
    const replay = replayRecording(path, { artifactDir: directory, engineFactory: async () => { ready(); return memory.engine; } },
      { speed: 1, signal: controller.signal });
    const rejected = assert.rejects(replay, { code: "ABORTED" });
    // 等待确实进入引擎生命周期，避免并行负载下 25ms 先于文件读取完成。
    await started;
    controller.abort();
    await rejected;
    assert.deepEqual(memory.calls.write, []);
    assert.equal(memory.calls.close, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("取消时引擎关闭悬挂也会有界失败并保留清理诊断", { timeout: 10000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "tuilens-replay-cleanup-abort-"));
  const controller = new AbortController();
  const memory = fake({
    snapshot: async (frameId) => { controller.abort(); return snapshot(frameId); },
    close: async () => new Promise<void>(() => {}),
  });
  try {
    const path = await recording(directory, [{ type: "end", truncated: false, atMs: 0 }]);
    const started = performance.now();
    await assert.rejects(replayRecording(path,
      { artifactDir: directory, engineFactory: async () => memory.engine }, { signal: controller.signal }),
    (error: unknown) => {
      assert.equal((error as { code: string }).code, "ABORTED");
      assert.match((error as { details: { cleanup: string } }).details.cleanup, /5 秒/u);
      return true;
    });
    assert.ok(performance.now() - started < 7000);
    assert.deepEqual(await readdir(directory), ["input.jsonl"]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
