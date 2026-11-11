import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { IPty } from "node-pty";
import { ManagedSession } from "../src/session/session.js";
import { SessionManager } from "../src/session/manager.js";
import { ProtocolReplyGuard } from "../src/session/protocol-replies.js";
import { TuiLensError } from "../src/core/errors.js";
import type { TerminalEngine, TerminalSnapshot } from "../src/core/types.js";
import { RecordingWriter } from "../src/recording/writer.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

function fixture(engine: TerminalEngine, path: string) {
  const data = new Set<(data: string) => void>();
  const exit = new Set<(event: { exitCode: number }) => void>();
  const written: string[] = [];
  let pauses = 0;
  let resumes = 0;
  const pty = {
    pid: 1, cols: 10, rows: 2,
    onData: (listener: (value: string) => void) => {
      data.add(listener);
      return { dispose: () => data.delete(listener) };
    },
    onExit: (listener: (event: { exitCode: number }) => void) => {
      exit.add(listener);
      return { dispose: () => exit.delete(listener) };
    },
    write: (value: string) => written.push(value),
    resize: () => {},
    kill: () => { for (const listener of exit) listener({ exitCode: 0 }); },
    pause: () => { pauses += 1; },
    resume: () => { resumes += 1; },
  } as unknown as IPty;
  const session = new ManagedSession({
    id: "test", pid: 1, cols: 10, rows: 2, status: "running", exitCode: null, createdAt: "now",
  }, engine, pty, path);
  return { session, written, data, exit, pressure: () => ({ pauses, resumes }),
    emit: (value: string) => { for (const listener of data) listener(value); } };
}

function snapshot(text: string, frameId: number): TerminalSnapshot {
  return { frameId, capturedAt: "now", cols: 10, rows: 2, text, lines: [text],
    cells: [], cursor: { x: 0, y: 0, visible: true, style: "block", blink: false },
    modes: { alternateScreen: false, bracketedPaste: false, applicationCursorKeys: false, mouseTracking: "none" } };
}

test("观察屏障保证截图期间的新输出不会混入同帧状态", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tuilens-barrier-"));
  const started = deferred<void>();
  const finish = deferred<void>();
  let current = "";
  let closed = 0;
  const engine: TerminalEngine = {
    state: async () => snapshot("", 0),
    write: async (data) => { current += data; },
    resize: async () => {},
    snapshot: async (frameId) => snapshot(current, frameId),
    screenshot: async () => {
      started.resolve();
      await finish.promise;
      return { png: Buffer.from(current), width: 100, height: 40 };
    },
    close: async () => { closed += 1; },
  };
  const f = fixture(engine, directory);
  try {
    f.emit("BEFORE");
    const observation = f.session.observe();
    await started.promise;
    f.emit("AFTER");
    finish.resolve();
    const first = await observation;
    assert.equal(first.snapshot.text, "BEFORE");
    assert.equal((await readFile(first.screenshot!.path)).toString(), "BEFORE");
    assert.equal(first.screenshot?.frameId, first.snapshot.frameId);
    const second = await f.session.observe({ screenshot: false });
    assert.equal(second.snapshot.text, "BEFOREAFTER");
    assert.equal(second.snapshot.frameId, first.snapshot.frameId + 1);
    await Promise.all([f.session.close(), f.session.close()]);
    assert.equal(closed, 1);
    assert.equal(f.data.size, 0);
    assert.equal(f.exit.size, 0);
  } finally {
    await f.session.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("引擎写入失败不会被后续观察伪装成成功", async () => {
  const engine: TerminalEngine = {
    state: async () => snapshot("", 0),
    write: async () => { throw new Error("broken parser"); },
    resize: async () => {},
    snapshot: async (frameId) => snapshot("", frameId),
    screenshot: async () => ({ png: Buffer.alloc(0), width: 0, height: 0 }),
    close: async () => {},
  };
  const f = fixture(engine, tmpdir());
  f.emit("bad");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.throws(() => f.session.observe(), /终端引擎处理失败/u);
  await f.session.close();
});

function memoryEngine() {
  let current = "";
  let snapshots = 0;
  let states = 0;
  let closes = 0;
  const writes: string[] = [];
  const snapshotWithCells = (frameId: number): TerminalSnapshot => {
    const lines = current.split("\n");
    return {
      ...snapshot(current, frameId),
      text: current,
      lines,
      cols: 160,
      rows: 50,
      cells: lines.map((line, y) => [...line].map((character, x) => ({
        x, y, text: character, width: 1, fg: "#ffffff", bg: "#000000",
        bold: false, italic: false, underline: false, inverse: false,
      }))),
    };
  };
  const engine: TerminalEngine = {
    write: async (value) => { writes.push(value); current += value; },
    state: async () => { states += 1; return snapshotWithCells(0); },
    hasText: async (text) => current.includes(text),
    resize: async () => {},
    snapshot: async (id) => { snapshots += 1; return snapshotWithCells(id); },
    screenshot: async () => ({ png: Buffer.from(current), width: 10, height: 2 }),
    close: async () => { closes += 1; },
  };
  return { engine, writes, get current() { return current; },
    counts: () => ({ snapshots, states, closes }) };
}

test("同一批输出合并但显式输入保留顺序，并以轻量状态编码", async () => {
  const memory = memoryEngine();
  const f = fixture(memory.engine, tmpdir());
  try {
    for (let i = 0; i < 100; i += 1) f.emit("中文🚀");
    await f.session.input({ type: "key", key: "Enter" });
    f.emit("END");
    const observed = await f.session.observe({ screenshot: false });
    assert.deepEqual(memory.writes, ["中文🚀".repeat(100), "END"]);
    assert.equal(observed.snapshot.text, "中文🚀".repeat(100) + "END");
    assert.deepEqual(f.written, ["\r"]);
    assert.equal(memory.counts().states, 1);
    assert.equal(memory.counts().snapshots, 1);
    const metrics = f.session.metrics();
    assert.equal(metrics.receivedBytes, Buffer.byteLength(observed.snapshot.text));
    assert.equal(metrics.receivedBytes, metrics.appliedBytes);
    assert.equal(metrics.pendingBytes, 0);
    assert.equal(metrics.writeBatches, 2);
    assert.ok(metrics.peakPendingBytes > 0);
  } finally { await f.session.close(); }
});

test("协议应答只转发及时且有查询匹配的数据", async () => {
  const guard = new ProtocolReplyGuard({ mode: "auto", maxLatencyMs: 20 });
  guard.observeOutput("\x1b[");
  guard.observeOutput("6n");
  assert.equal(guard.shouldForward("\x1b[1;1R"), true);
  guard.observeOutput("\x1b[c");
  await new Promise<void>((resolve) => setTimeout(resolve, 30));
  assert.equal(guard.shouldForward("\x1b[?1;2c"), false);
  assert.equal(guard.shouldForward("\x1b[<1;1;1M"), true);
  assert.equal(guard.shouldForward("\x1b[?1006;2$y"), false);
  const metrics = guard.metrics();
  assert.equal(metrics.protocolQueries, 2);
  assert.equal(metrics.protocolRepliesForwarded, 2);
  assert.equal(metrics.protocolRepliesDropped, 2);
  assert.ok(metrics.lastProtocolReplyLatencyMs >= 20);
  assert.equal(new ProtocolReplyGuard({ mode: "suppress" }).shouldForward("\x1b[1;1R"), false);
  const suppressed = new ProtocolReplyGuard({ mode: "suppress" });
  assert.equal(suppressed.shouldForward("PING"), true);
  assert.equal(suppressed.metrics().protocolRepliesForwarded, 1);
  assert.equal(suppressed.metrics().protocolRepliesDropped, 0);
  assert.equal(suppressed.shouldForward("\x1b[1;1R"), false);
});

test("输入捕获 frameId 与光标，且显式输入只写一次", async () => {
  const memory = memoryEngine();
  const f = fixture(memory.engine, tmpdir());
  try {
    const result = await f.session.inputWithFrame({ type: "key", key: "Enter" });
    assert.equal(result.frameId, 0);
    assert.deepEqual(result.cursor, { x: 0, y: 0, visible: true, style: "block", blink: false });
    assert.deepEqual(f.written, ["\r"]);
  } finally { await f.session.close(); }
});

test("inputAndWait 在可观测输出后返回，超时保留已接收证据", { timeout: 10000 }, async () => {
  const memory = memoryEngine();
  const manager = new SessionManager({ artifactDir: tmpdir(), engineFactory: async () => memory.engine });
  try {
    const session = await manager.launch({ command: process.execPath, args: ["-e",
      "process.stdin.setRawMode(true);process.stdin.resume();process.stdout.write('READY\\n');process.stdin.once('data',()=>setTimeout(()=>process.stdout.write('WAIT_ACK\\n'),60));setInterval(()=>{},1000)"] });
    await manager.wait(session.id, { conditions: [{ kind: "text", text: "READY" }], timeoutMs: 2000 });
    const confirmed = await manager.inputAndWait(session.id, { type: "text", text: "x" }, undefined, {
      conditions: [{ kind: "text", text: "WAIT_ACK" }, { kind: "cursor", x: 0, y: 0, visible: true }],
      timeoutMs: 2000,
    });
    assert.match(confirmed.observation.snapshot.text, /WAIT_ACK/u);
    assert.equal(confirmed.session.status, "running");
    assert.equal(confirmed.cursorBefore.visible, true);
    await manager.close(session.id);

    const stuck = await manager.launch({ command: process.execPath, args: ["-e",
      "process.stdin.setRawMode(true);process.stdin.resume();process.stdout.write('READY\\n');setInterval(()=>{},1000)"] });
    await manager.wait(stuck.id, { conditions: [{ kind: "text", text: "READY" }], timeoutMs: 2000 });
    await assert.rejects(manager.inputAndWait(stuck.id, { type: "text", text: "x" }, undefined, {
      conditions: [{ kind: "text", text: "NEVER" }], timeoutMs: 50,
    }), (error: unknown) => error instanceof TuiLensError && error.code === "WAIT_TIMEOUT"
      && (error.details as { accepted?: boolean; inputFrameId?: number }).accepted === true
      && typeof (error.details as { inputFrameId?: number }).inputFrameId === "number");
  } finally { await manager.closeAll(); }
});

test("inputAndWait 输入后截图失败仍保留已接收证据", { timeout: 10000 }, async () => {
  const memory = memoryEngine();
  const engine: TerminalEngine = {
    ...memory.engine,
    screenshot: async () => { throw new TuiLensError("OPERATION_TIMEOUT", "截图超时"); },
  };
  const manager = new SessionManager({ artifactDir: tmpdir(), engineFactory: async () => engine });
  try {
    const session = await manager.launch({ command: process.execPath, args: ["-e",
      "process.stdin.setRawMode(true);process.stdin.resume();process.stdout.write('READY\\n');process.stdin.once('data',()=>process.stdout.write('ACK\\n'));setInterval(()=>{},1000)"] });
    await manager.wait(session.id, { conditions: [{ kind: "text", text: "READY" }], timeoutMs: 2000 });
    await assert.rejects(manager.inputAndWait(session.id, { type: "text", text: "x" }, undefined, {
      conditions: [{ kind: "text", text: "ACK" }], timeoutMs: 2000,
    }, undefined, true), (error: unknown) => error instanceof TuiLensError && error.code === "OPERATION_TIMEOUT"
      && (error.details as { accepted?: boolean; inputFrameId?: number }).accepted === true
      && typeof (error.details as { inputFrameId?: number }).inputFrameId === "number");
  } finally { await manager.closeAll(); }
});

test("FRAME_PENDING 重试等待期间取消返回 ABORTED", async () => {
  const memory = memoryEngine();
  const snapshotStarted = deferred<void>();
  const f = fixture({
    ...memory.engine,
    snapshot: async () => {
      snapshotStarted.resolve();
      throw new TuiLensError("FRAME_PENDING", "同步帧未提交");
    },
  }, tmpdir());
  const controller = new AbortController();
  try {
    const observing = f.session.observe({ screenshot: false }, { signal: controller.signal, timeoutMs: 5000 });
    await snapshotStarted.promise;
    controller.abort();
    await assert.rejects(observing, { code: "ABORTED" });
  } finally { await f.session.close(); }
});

test("大批 Unicode 输出按上限拆分且不破坏代理对", async () => {
  const memory = memoryEngine();
  const f = fixture(memory.engine, tmpdir());
  const value = "a".repeat(32767) + "🚀" + "中".repeat(70000);
  try {
    f.emit(value);
    const observed = await f.session.observe({ screenshot: false });
    assert.equal(observed.snapshot.text, value);
    assert.ok(memory.writes.length >= 3);
    assert.ok(memory.writes.every((chunk) => chunk.length <= 32768 && !/[\ud800-\udbff]$/u.test(chunk)));
    assert.equal(f.session.metrics().appliedBytes, Buffer.byteLength(value));
    assert.equal(f.session.metrics().pendingBytes, 0);
  } finally { await f.session.close(); }
});

test("同步帧未结束时观察释放队列，让后续结束序列继续应用", async () => {
  let open = false;
  const memory = memoryEngine();
  const engine: TerminalEngine = {
    ...memory.engine,
    write: async (data) => { open = data !== "END"; await memory.engine.write(data); },
    snapshot: async (id) => {
      if (open) throw new TuiLensError("FRAME_PENDING", "尚未结束");
      return memory.engine.snapshot(id);
    },
  };
  const f = fixture(engine, tmpdir());
  try {
    f.emit("BEGIN");
    const observation = f.session.observe({ screenshot: false }, { timeoutMs: 500 });
    setTimeout(() => f.emit("END"), 20);
    const result = await observation;
    assert.equal(result.snapshot.text, "BEGINEND");
    assert.equal(result.snapshot.frameId, 2);
  } finally { await f.session.close(); }
});

test("取消能打断正在等待的观察，迟到快照不触发截图", async () => {
  const start = deferred<void>();
  const finish = deferred<void>();
  const memory = memoryEngine();
  let screenshots = 0;
  const f = fixture({
    ...memory.engine,
    snapshot: async (id) => {
      start.resolve();
      await finish.promise;
      return snapshot("late", id);
    },
    screenshot: async () => { screenshots += 1; return { png: Buffer.alloc(0), width: 0, height: 0 }; },
  }, tmpdir());
  try {
    const abort = new AbortController();
    const observed = f.session.observe({}, { signal: abort.signal });
    await start.promise;
    abort.abort();
    await assert.rejects(observed, { code: "ABORTED" });
    finish.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(screenshots, 0);
  } finally { finish.resolve(); await f.session.close(); }
});

test("进程退出状态等待最后输出应用完成，期间无需快照", async () => {
  const memory = memoryEngine();
  const finish = deferred<void>();
  const f = fixture({
    ...memory.engine,
    write: async (data) => { await finish.promise; await memory.engine.write(data); },
  }, tmpdir());
  try {
    f.emit("LAST_BYTES");
    for (const callback of f.exit) callback({ exitCode: 0 });
    let exited = false;
    const wait = f.session.waitForExit({ timeoutMs: 1000 }).then(() => { exited = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(exited, false);
    assert.equal(memory.counts().snapshots, 0);
    finish.resolve();
    await wait;
    assert.equal(f.session.info().status, "exited");
    assert.equal((await f.session.observe({ screenshot: false })).snapshot.text, "LAST_BYTES");
    assert.equal(f.session.metrics().pendingBytes, 0);
  } finally { finish.resolve(); await f.session.close(); }
});

test("closeAll 等待正在创建的引擎完成清理，不遗漏迟到启动", async () => {
  const started = deferred<void>();
  const release = deferred<void>();
  const memory = memoryEngine();
  const manager = new SessionManager({
    artifactDir: tmpdir(),
    engineFactory: async () => { started.resolve(); await release.promise; return memory.engine; },
  });
  const launching = manager.launch({ command: process.execPath, args: ["-e", ""] });
  const rejected = assert.rejects(launching, { code: "MANAGER_CLOSED" });
  await started.promise;
  let completed = false;
  const closing = manager.closeAll().then(() => { completed = true; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(completed, false);
  release.resolve();
  await rejected;
  await closing;
  assert.equal(memory.counts().closes, 1);
  assert.deepEqual(manager.list(), []);
});

test("真实 PTY 退出等待只读取最终快照且保留最后标记", { timeout: 15000 }, async () => {
  const memory = memoryEngine();
  const manager = new SessionManager({ artifactDir: tmpdir(), engineFactory: async () => memory.engine });
  try {
    const session = await manager.launch({
      command: process.execPath,
      args: ["-e", "process.stdout.write('FIRST\\n');setTimeout(()=>process.stdout.write('LAST_SENTINEL\\n'),50)"],
    });
    const result = await manager.wait(session.id, { conditions: [{ kind: "exited" }], timeoutMs: 10000 });
    assert.match(result.observation.snapshot.text, /LAST_SENTINEL/u);
    assert.equal(result.observation.session.exitCode, 0);
    assert.equal(memory.counts().snapshots, 1);
    const metrics = manager.metrics(session.id);
    assert.equal(metrics.pendingBytes, 0);
    assert.equal(metrics.receivedBytes, metrics.appliedBytes);
    await manager.close(session.id);
    await manager.close(session.id);
  } finally { await manager.closeAll(); }
});

test("普通文本等待仅在命中后传输完整快照", { timeout: 15000 }, async () => {
  const memory = memoryEngine();
  let output = "";
  let probes = 0;
  const manager = new SessionManager({ artifactDir: tmpdir(), engineFactory: async () => ({
    ...memory.engine,
    write: async (data) => { output += data; await memory.engine.write(data); },
    hasText: async (text) => { probes += 1; return output.includes(text); },
    snapshot: async (frameId) => {
      const observed = await memory.engine.snapshot(frameId);
      const text = output.includes("FAST_READY") ? "FAST_READY" : "START";
      return { ...observed, cells: [[...text].map((character, x) => ({
        x, y: 0, text: character, width: 1, fg: "#ffffff", bg: "#000000",
        bold: false, italic: false, underline: false, inverse: false,
      }))] };
    },
  }) });
  try {
    const session = await manager.launch({ command: process.execPath, args: ["-e",
      "process.stdout.write('START\\n');setTimeout(()=>process.stdout.write('FAST_READY\\n'),150)"] });
    const result = await manager.wait(session.id, { conditions: [{ kind: "text", text: "FAST_READY" }], timeoutMs: 5000 });
    assert.match(result.observation.snapshot.text, /FAST_READY/);
    assert.ok(probes >= 2);
    assert.equal(memory.counts().snapshots, 1);
  } finally { await manager.closeAll(); }
});

test("输出积压触发背压并在消费后恢复，计数不丢失", async () => {
  const gate = deferred<void>();
  const memory = memoryEngine();
  const f = fixture({
    ...memory.engine,
    write: async (data) => { await gate.promise; await memory.engine.write(data); },
  }, tmpdir());
  try {
    const data = "x".repeat(9 * 1024 * 1024);
    f.emit(data);
    assert.equal(f.pressure().pauses, 1);
    assert.equal(f.session.metrics().pauseCount, 1);
    assert.equal(f.session.metrics().peakPendingBytes, data.length);
    gate.resolve();
    await f.session.observe({ screenshot: false });
    assert.equal(f.pressure().resumes, 1);
    assert.equal(f.session.metrics().appliedBytes, data.length);
    assert.equal(f.session.metrics().pendingBytes, 0);
  } finally { gate.resolve(); await f.session.close(); }
});

test("FRAME_PENDING 持续存在时有界失败而不永久锁住会话", async () => {
  const memory = memoryEngine();
  const f = fixture({
    ...memory.engine,
    snapshot: async () => { throw new TuiLensError("FRAME_PENDING", "等待同步结束"); },
  }, tmpdir());
  try {
    const started = performance.now();
    await assert.rejects(f.session.observe({ screenshot: false }, { timeoutMs: 40 }),
      { code: "FRAME_PENDING" });
    assert.ok(performance.now() - started < 1000);
    await f.session.input({ type: "key", key: "Escape" });
    assert.deepEqual(f.written, ["\x1b"]);
  } finally { await f.session.close(); }
});

test("clickText 显式允许未提交帧，同时保留目标区域指纹保护", async () => {
  const memory = memoryEngine();
  const frames: { id: number; pending: boolean }[] = [];
  let text = "Run";
  let mutateAfter = Number.POSITIVE_INFINITY;
  const baseState = await memory.engine.state();
  const manager = new SessionManager({ artifactDir: tmpdir(), engineFactory: async () => ({
    ...memory.engine,
    state: async () => ({
      ...baseState,
      modes: { ...baseState.modes, mouseTracking: "any", mouseEncoding: "sgr", synchronizedOutput: true },
    }),
    snapshot: async (id, options) => {
      frames.push({ id, pending: options?.allowPendingFrame === true });
      if (!options?.allowPendingFrame) throw new TuiLensError("FRAME_PENDING", "同步帧未提交");
      if (frames.length > mutateAfter) text = "Changed";
      const result = await memory.engine.snapshot(id);
      return {
        ...result, cols: 20, rows: 5,
        text, lines: [text],
        cells: [[text, "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", ""].map((text, x) => ({
          x, y: 0, text, width: 1, fg: "#ffffff", bg: "#000000",
          bold: false, italic: false, underline: false, inverse: false,
        }))],
        modes: { ...result.modes, mouseTracking: "any", mouseEncoding: "sgr", synchronizedOutput: true },
      };
    },
  }) });
  try {
    const launched = await manager.launch({ command: process.execPath, args: ["-e", "setInterval(()=>{},1000)"] });
    await manager.clickText(launched.id, "Run", undefined, { allowPendingFrame: true });
    text = "Run";
    mutateAfter = frames.length + 1;
    await assert.rejects(manager.clickText(launched.id, "Run", undefined, { allowPendingFrame: true }), { code: "STALE_REGION" });
    await assert.rejects(manager.clickText(launched.id, "Changed", undefined, {}, { timeoutMs: 50 }),
      { code: "FRAME_PENDING" });
    await assert.rejects(manager.clickText(launched.id, "Run", undefined, { allowPendingFrame: "yes" as unknown as boolean }),
      { code: "INVALID_ARGUMENT" });
    assert.equal(frames[0]?.pending, true);
    assert.ok(frames.some(({ pending }) => !pending));
  } finally { await manager.closeAll(); }
});

test("取消排队中的输入和 resize 后不执行迟到操作", async () => {
  const memory = memoryEngine();
  const gate = deferred<void>();
  let resized = 0;
  const f = fixture({ ...memory.engine,
    write: async () => { await gate.promise; },
    resize: async () => { resized += 1; },
  }, tmpdir());
  try {
    f.emit("BLOCK");
    const controller = new AbortController();
    const input = f.session.input({ type: "key", key: "Enter" }, undefined, { signal: controller.signal });
    const resize = f.session.resize(20, 5, { signal: controller.signal });
    const rejectedInput = assert.rejects(input, { code: "ABORTED" });
    const rejectedResize = assert.rejects(resize, { code: "ABORTED" });
    controller.abort();
    gate.resolve();
    await Promise.all([rejectedInput, rejectedResize]);
    await f.session.observe({ screenshot: false });
    assert.deepEqual(f.written, []);
    assert.equal(resized, 0);
  } finally { gate.resolve(); await f.session.close(); }
});

test("显式关闭丢弃在途输出时录制标记不完整", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tuilens-incomplete-"));
  const writer = await RecordingWriter.create(directory, "close", { type: "header", version: 1, cols: 10, rows: 2, images: "off" });
  const memory = memoryEngine();
  const data = new Set<(value: string) => void>();
  const exited = new Set<(event: { exitCode: number }) => void>();
  const pty = { onData: (fn: (data: string) => void) => { data.add(fn); return { dispose: () => data.delete(fn) }; },
    onExit: (fn: (event: { exitCode: number }) => void) => { exited.add(fn); return { dispose: () => exited.delete(fn) }; },
    kill: () => { for (const fn of exited) fn({ exitCode: 0 }); }, pause() {}, resume() {},
  } as unknown as IPty;
  const session = new ManagedSession({ id: "cap", pid: 1, cols: 10, rows: 2, status: "running", exitCode: null, createdAt: "" },
    memory.engine, pty, directory, writer);
  try {
    for (const fn of data) fn("MUST_PERSIST");
    await session.close();
    const records = (await readFile(writer.path, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(records.at(-1).truncated, true);
  } finally { await session.close(); await rm(directory, { recursive: true, force: true }); }
});

test("回放受统一生命周期管理，关闭后禁止创建并等待迟到引擎释放", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tuilens-replay-lifecycle-"));
  const path = join(directory, "fixture.jsonl");
  await writeFile(path, [
    JSON.stringify({ type: "header", version: 1, cols: 10, rows: 2, images: "off" }),
    JSON.stringify({ type: "end", truncated: false, atMs: 0 }), "",
  ].join("\n"));
  const ready = deferred<void>(), release = deferred<void>();
  const memory = memoryEngine();
  const manager = new SessionManager({ artifactDir: directory, engineFactory: async () => {
    ready.resolve(); await release.promise; return memory.engine;
  } });
  try {
    const replay = manager.replay(path);
    const rejected = assert.rejects(replay, { code: "ABORTED" });
    await ready.promise;
    let finished = false;
    const closing = manager.closeAll().then(() => { finished = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(finished, false);
    release.resolve();
    await rejected;
    await closing;
    assert.equal(memory.counts().closes, 1);
    await assert.rejects(manager.replay(path), { code: "MANAGER_CLOSED" });
  } finally { release.resolve(); await manager.closeAll(); await rm(directory, { recursive: true, force: true }); }
});
