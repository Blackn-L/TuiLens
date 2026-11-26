import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { EventEmitter, once } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { connect, createServer, Socket, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { TuiLensError } from "../src/core/errors.js";
import type { OperationProgress, SessionInfo } from "../src/core/types.js";
import { IpcClient, isDaemonUnavailable, request, sleepWithSignal } from "../src/transport/client.js";
import { daemonEnvironment, runtimePaths } from "../src/transport/paths.js";
import {
  encodeFrame,
  MAX_INFLIGHT_PER_CONNECTION,
  MAX_REQUEST_BYTES,
  serverFrameSchema,
  type ClientFrame,
  type IpcEventName,
  type ServerFrame,
} from "../src/transport/protocol.js";
import { writeFrameBeforeStop } from "../src/transport/server.js";

const execute = promisify(execFile);
const cli = fileURLToPath(new URL("../src/interfaces/cli.js", import.meta.url));
const clientModule = fileURLToPath(new URL("../src/transport/client.js", import.meta.url));
const fixture = fileURLToPath(new URL("./fixtures/terminal.js", import.meta.url));
const stubSockets = new Set<Socket>();

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function errorFrame(
  code: string,
  message = code
): {
  code: string;
  message: string;
  messageEn: string;
  messageZh: string;
} {
  return { code, message, messageEn: message, messageZh: message };
}

async function startIpcStub(socketPath: string, handler: (socket: Socket) => void): Promise<Server> {
  const server = createServer((socket) => {
    stubSockets.add(socket);
    socket.once("close", () => stubSockets.delete(socket));
    handler(socket);
  });
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(socketPath);
  });
  return server;
}

async function closeIpcStub(server: Server | undefined): Promise<void> {
  if (!server?.listening) return;
  for (const socket of stubSockets) socket.destroy();
  stubSockets.clear();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function startV2Stub(
  socketPath: string,
  handler: (socket: Socket, frame: Extract<ClientFrame, { type: "req" }>) => void,
  expectedToken?: string
): Promise<Server> {
  return startIpcStub(socketPath, (socket) => {
    socket.setEncoding("utf8");
    let buffer = "";
    let authenticated = false;
    socket.on("data", (part: string) => {
      buffer += part;
      while (true) {
        const end = buffer.indexOf("\n");
        if (end < 0) return;
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (!line) continue;
        let frame: unknown;
        try {
          frame = JSON.parse(line);
        } catch {
          socket.destroy();
          return;
        }
        if (!authenticated) {
          if (
            typeof frame !== "object" ||
            frame === null ||
            (frame as { type?: unknown }).type !== "auth" ||
            (expectedToken !== undefined && (frame as { token?: unknown }).token !== expectedToken)
          ) {
            socket.end(
              encodeFrame({
                type: "auth_error",
                error: errorFrame("UNAUTHORIZED", "bad token"),
              })
            );
            return;
          }
          authenticated = true;
          socket.write(
            encodeFrame({
              type: "auth_ok",
              version: 2,
              daemonPid: process.pid,
              daemonVersion: "test",
            })
          );
          continue;
        }
        if (
          typeof frame === "object" &&
          frame !== null &&
          (frame as { type?: unknown }).type === "req" &&
          typeof (frame as { id?: unknown }).id === "string"
        ) {
          handler(socket, frame as Extract<ClientFrame, { type: "req" }>);
        }
      }
    });
  });
}

class RawIpcClient {
  private readonly frames: ServerFrame[] = [];
  private readonly waiters = new Set<() => void>();
  private buffer = "";
  private failure: Error | null = null;
  private closed = false;

  private constructor(readonly socket: Socket) {
    socket.setEncoding("utf8");
    socket.on("data", (part: string) => this.receive(part));
    socket.on("error", (error) => {
      this.failure = error;
      this.notify();
    });
    socket.on("close", () => {
      this.closed = true;
      this.failure ??= new Error("IPC connection closed");
      this.notify();
    });
  }

  static async open(socketPath: string): Promise<RawIpcClient> {
    const socket = connect(socketPath);
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    return new RawIpcClient(socket);
  }

  sendRaw(text: string): void {
    this.socket.write(text);
  }

  writeFrame(frame: unknown): void {
    this.socket.write(encodeFrame(frame as ClientFrame));
  }

  async next(predicate: (frame: ServerFrame) => boolean, timeoutMs = 5000): Promise<ServerFrame> {
    return new Promise<ServerFrame>((resolve, reject) => {
      const finish = (): void => {
        const index = this.frames.findIndex(predicate);
        if (index >= 0) {
          cleanup();
          resolve(this.frames.splice(index, 1)[0]!);
          return;
        }
        if (this.failure) {
          cleanup();
          reject(this.failure);
        }
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("timed out waiting for IPC frame"));
      }, timeoutMs);
      const cleanup = (): void => {
        clearTimeout(timer);
        this.waiters.delete(finish);
      };
      this.waiters.add(finish);
      finish();
    });
  }

  async close(): Promise<void> {
    if (!this.socket.destroyed) this.socket.destroy();
    if (!this.closed) {
      await new Promise<void>((resolve) => this.socket.once("close", () => resolve()));
    }
  }

  private receive(part: string): void {
    this.buffer += part;
    while (true) {
      const end = this.buffer.indexOf("\n");
      if (end < 0) return;
      const line = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 1);
      if (!line) continue;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        this.failure = new Error("invalid server JSON");
        this.socket.destroy();
        return;
      }
      const parsed = serverFrameSchema.safeParse(value);
      if (!parsed.success) {
        this.failure = new Error("invalid server frame");
        this.socket.destroy();
        return;
      }
      this.frames.push(parsed.data);
      this.notify();
    }
  }

  private notify(): void {
    for (const waiter of [...this.waiters]) waiter();
  }
}

async function daemonToken(): Promise<string> {
  const state = JSON.parse(await readFile(runtimePaths().state, "utf8")) as { token?: unknown };
  assert.equal(typeof state.token, "string");
  return state.token as string;
}

async function launchFixture(): Promise<SessionInfo> {
  return (await request("launch", {
    command: process.execPath,
    args: [fixture],
    cols: 40,
    rows: 8,
  })) as SessionInfo;
}

test("状态文件发布失败时服务退出，不留下半启动端点", { timeout: 15000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), "tuilens-start-fail-"));
  try {
    await mkdir(join(home, "daemon.json"));
    await assert.rejects(
      execute(process.execPath, [cli, "_serve"], {
        env: { ...process.env, TUILENS_HOME: home },
        timeout: 5000,
      }),
      (error: unknown) => {
        const e = error as { code?: number; killed?: boolean; stdout?: string };
        assert.equal(e.killed, false, "必须自行退出，不能靠测试超时杀进程");
        assert.equal(e.code, 1);
        assert.match(e.stdout ?? "", /EISDIR|EPERM|illegal operation/u);
        return true;
      }
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("并发自动启动只连接同一服务，关闭后可再次启动", { timeout: 30000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), "tuilens-start-race-"));
  const env = { ...process.env, TUILENS_HOME: home };
  const call = async (command: string) => {
    const result = await execute(process.execPath, [cli, command], { env, timeout: 15000 });
    return JSON.parse(result.stdout) as {
      ok: boolean;
      data: {
        pid: number;
        version: string;
        uptimeMs: number;
        sessions: number;
        pendingLaunches: number;
        offline: number;
        disposed: boolean;
      };
    };
  };
  try {
    for (const name of ["daemon-start.lock", "daemon-start.lock.cleanup"]) {
      const staleLock = join(home, name);
      await writeFile(staleLock, JSON.stringify({ pid: process.pid, token: `stale-${name}`, at: 0 }));
      await utimes(staleLock, new Date(0), new Date(0));
    }
    const responses = await Promise.all(Array.from({ length: 5 }, () => call("ping")));
    assert.ok(responses.every((response) => response.ok));
    assert.equal(new Set(responses.map((response) => response.data.pid)).size, 1);
    assert.equal(existsSync(join(home, "daemon-start.lock")), false);
    assert.equal(existsSync(join(home, "daemon-start.lock.cleanup")), false);
    assert.equal(typeof responses[0]!.data.version, "string");
    assert.equal(responses[0]!.data.sessions, 0);
    await call("shutdown");
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try {
        process.kill(responses[0]!.data.pid, 0);
      } catch {
        break;
      }
      await sleep(50);
    }
    const restarted = await call("ping");
    assert.notEqual(restarted.data.pid, responses[0]!.data.pid);
  } finally {
    await call("shutdown").catch(() => null);
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test("daemon 切换目录前固定浏览器和字体路径，保留空值与缺省配置", () => {
  const home = resolve(".runtime");
  const inherited = { TUILENS_BROWSER_PATH: "bin/browser", TUILENS_FONT_FILE: "fonts/mono.ttf", LANG: "zh_CN" };
  assert.deepEqual(daemonEnvironment(home, inherited), {
    TUILENS_HOME: home,
    TUILENS_BROWSER_PATH: resolve("bin/browser"),
    TUILENS_FONT_FILE: resolve("fonts/mono.ttf"),
    LANG: inherited.LANG,
  });
  assert.deepEqual(daemonEnvironment(home, { TUILENS_FONT_FILE: "" }), { TUILENS_HOME: home, TUILENS_FONT_FILE: "" });
});

test("相对 TUILENS_HOME 的服务在 shutdown 关闭窗口内可自动重启", { timeout: 30000 }, async () => {
  const caller = await mkdtemp(join(tmpdir(), "tuilens-shutdown-restart-"));
  const home = join(caller, "runtime");
  const env = { ...process.env, TUILENS_HOME: "runtime" };
  const call = async (command: string): Promise<{ ok: boolean; data: { pid: number } }> => {
    const result = await execute(process.execPath, [cli, command], { cwd: caller, env, timeout: 15000 });
    return JSON.parse(result.stdout) as { ok: boolean; data: { pid: number } };
  };
  try {
    const first = await call("ping");
    assert.equal(JSON.parse(await readFile(join(home, "daemon.json"), "utf8")).pid, first.data.pid);
    await call("shutdown");
    const restarted = await call("ping");
    assert.equal(restarted.ok, true);
    assert.notEqual(restarted.data.pid, first.data.pid);
  } finally {
    // A server started by a regressed build may have resolved "runtime" twice.
    for (const directory of [home, join(home, "runtime")]) {
      if (existsSync(join(directory, "daemon.json"))) {
        await execute(process.execPath, [cli, "shutdown"], { env: { ...env, TUILENS_HOME: directory }, timeout: 5000 });
      }
    }
    await rm(caller, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test("shutdown 在没有 daemon 时可重复执行", { timeout: 15000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), "tuilens-shutdown-idle-"));
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = await execute(process.execPath, [cli, "shutdown"], {
        env: { ...process.env, TUILENS_HOME: home },
        timeout: 10000,
      });
      const payload = JSON.parse(result.stdout) as {
        ok: boolean;
        data: { stopped: boolean; alreadyStopped: boolean };
      };
      assert.equal(payload.ok, true);
      assert.deepEqual(payload.data, { stopped: true, alreadyStopped: true });
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("同进程持久客户端在 daemon 重启后自动重连", { timeout: 20000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), "tuilens-reconnect-v2-"));
  const previousHome = process.env.TUILENS_HOME;
  process.env.TUILENS_HOME = home;
  try {
    const first = (await request("ping", {}, { timeoutMs: 5000 })) as { pid: number };
    await request("shutdown", {}, { autoStart: false });
    await sleep(150);
    const second = (await request("ping", {}, { timeoutMs: 5000 })) as { pid: number };
    assert.notEqual(second.pid, first.pid);
  } finally {
    await request("shutdown", {}, { autoStart: false }).catch(() => null);
    restoreEnv("TUILENS_HOME", previousHome);
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test("AbortSignal 立即中断锁轮询 sleep", { timeout: 3000 }, async () => {
  const controller = new AbortController();
  const started = performance.now();
  const timer = setTimeout(() => controller.abort(), 20);
  try {
    await assert.rejects(sleepWithSignal(10_000, controller.signal), { code: "ABORTED" });
    assert.ok(performance.now() - started < 500);
  } finally {
    clearTimeout(timer);
  }
});

test("AbortSignal 中断启动锁等待", { timeout: 5000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), "tuilens-abort-lock-"));
  const previousHome = process.env.TUILENS_HOME;
  process.env.TUILENS_HOME = home;
  try {
    const paths = runtimePaths();
    await mkdir(paths.home, { recursive: true });
    await writeFile(paths.startLock, JSON.stringify({ pid: process.pid, token: "held-start-lock", at: Date.now() }));
    const controller = new AbortController();
    const started = performance.now();
    const timer = setTimeout(() => controller.abort(), 80);
    try {
      await assert.rejects(request("ping", {}, { signal: controller.signal }), { code: "ABORTED" });
      assert.ok(performance.now() - started < 1000);
    } finally {
      clearTimeout(timer);
    }
  } finally {
    restoreEnv("TUILENS_HOME", previousHome);
    await rm(home, { recursive: true, force: true, maxRetries: 5 });
  }
});

test("autoStart:false 将断连与 SHUTTING_DOWN 统一为 DAEMON_UNAVAILABLE", {
  timeout: 10000,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), "tuilens-auto-start-"));
  const previousHome = process.env.TUILENS_HOME;
  process.env.TUILENS_HOME = home;
  let server: Server | undefined;
  try {
    const paths = runtimePaths();
    await mkdir(paths.home, { recursive: true });
    await writeFile(paths.state, JSON.stringify({ token: "a", pid: process.pid }));
    assert.equal(isDaemonUnavailable({ code: "IPC_CLOSED" }), true);

    server = await startIpcStub(paths.socket, (socket) => socket.destroy());
    await assert.rejects(request("ping", {}, { autoStart: false }), { code: "DAEMON_UNAVAILABLE" });
    await closeIpcStub(server);
    server = undefined;

    const token = randomBytes(16).toString("hex");
    await writeFile(paths.state, JSON.stringify({ token, pid: process.pid }));
    server = await startV2Stub(
      paths.socket,
      (socket, frame) => {
        socket.write(
          encodeFrame({
            type: "res",
            id: frame.id,
            ok: false,
            error: errorFrame("SHUTTING_DOWN", "shutting down"),
          })
        );
      },
      token
    );
    await assert.rejects(request("ping", {}, { autoStart: false }), { code: "DAEMON_UNAVAILABLE" });
  } finally {
    await closeIpcStub(server);
    restoreEnv("TUILENS_HOME", previousHome);
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test("IPC 连接保留 EACCES 原始错误，不伪装为 DAEMON_UNAVAILABLE", async () => {
  const home = await mkdtemp(join(tmpdir(), "tuilens-socket-error-"));
  const previousHome = process.env.TUILENS_HOME;
  process.env.TUILENS_HOME = home;
  try {
    const paths = runtimePaths();
    await mkdir(paths.home, { recursive: true });
    await writeFile(paths.state, JSON.stringify({ token: randomBytes(16).toString("hex"), pid: process.pid }));
    const denied = Object.assign(new Error("connect EACCES: access denied"), {
      code: "EACCES",
    }) as NodeJS.ErrnoException;
    const socket = new Socket();
    const connector = (() => {
      process.nextTick(() => {
        socket.emit("error", denied);
        socket.emit("close");
      });
      return socket;
    }) as unknown as typeof connect;
    const client = new IpcClient(paths, connector);
    await assert.rejects(client.call("ping", {}, { timeoutMs: 1000 }), (error: unknown) => {
      assert.ok(error instanceof TuiLensError);
      assert.equal(error.code, "EACCES");
      assert.equal(isDaemonUnavailable(error), false);
      assert.match(error.message, /access denied/u);
      return true;
    });
    socket.destroy();
  } finally {
    restoreEnv("TUILENS_HOME", previousHome);
    await rm(home, { recursive: true, force: true, maxRetries: 5 });
  }
});

test("shutdown 响应在写回调后才停止，并有超时兜底", async () => {
  let callback: ((error?: Error) => void) | undefined;
  let written = "";
  let stops = 0;
  const socket = {
    writable: true,
    destroyed: false,
    write(chunk: string, done?: (error?: Error) => void): boolean {
      written += chunk;
      callback = done;
      return true;
    },
  };
  const frame: ServerFrame = {
    type: "res",
    id: randomUUID(),
    ok: true,
    data: { stopped: true },
  };
  writeFrameBeforeStop(
    socket as unknown as Pick<Socket, "writable" | "destroyed" | "write">,
    frame,
    () => {
      stops += 1;
    },
    1000
  );
  assert.equal(stops, 0);
  assert.match(written, /"stopped":true/u);
  callback?.();
  callback?.();
  assert.equal(stops, 1);

  let fallbackStops = 0;
  writeFrameBeforeStop(
    socket as unknown as Pick<Socket, "writable" | "destroyed" | "write">,
    frame,
    () => {
      fallbackStops += 1;
    },
    10
  );
  await sleep(30);
  assert.equal(fallbackStops, 1);
  callback?.();
  assert.equal(fallbackStops, 1);
});

test("AbortSignal 中断已经发送的持久连接请求", { timeout: 10000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), "tuilens-abort-request-"));
  const previousHome = process.env.TUILENS_HOME;
  process.env.TUILENS_HOME = home;
  let server: Server | undefined;
  try {
    const paths = runtimePaths();
    await mkdir(paths.home, { recursive: true });
    const token = randomBytes(16).toString("hex");
    await writeFile(paths.state, JSON.stringify({ token, pid: process.pid }));
    server = await startV2Stub(paths.socket, () => {}, token);
    const controller = new AbortController();
    const started = performance.now();
    const timer = setTimeout(() => controller.abort(), 150);
    try {
      await assert.rejects(request("ping", {}, { signal: controller.signal }), { code: "ABORTED" });
      assert.ok(performance.now() - started < 1500);
    } finally {
      clearTimeout(timer);
    }
  } finally {
    await closeIpcStub(server);
    restoreEnv("TUILENS_HOME", previousHome);
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test("客户端握手超时后释放连接", { timeout: 5000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), "tuilens-client-handshake-timeout-"));
  const previousHome = process.env.TUILENS_HOME;
  const previousTimeout = process.env.TUILENS_IPC_HANDSHAKE_TIMEOUT_MS;
  process.env.TUILENS_HOME = home;
  process.env.TUILENS_IPC_HANDSHAKE_TIMEOUT_MS = "120";
  let server: Server | undefined;
  try {
    const paths = runtimePaths();
    await mkdir(paths.home, { recursive: true });
    await writeFile(paths.state, JSON.stringify({ token: "a", pid: process.pid }));
    server = await startIpcStub(paths.socket, (socket) => {
      socket.setEncoding("utf8");
      socket.on("data", () => {});
    });
    const started = performance.now();
    await assert.rejects(request("ping", {}, { autoStart: false }), { code: "IPC_TIMEOUT" });
    assert.ok(performance.now() - started < 2000);
  } finally {
    await closeIpcStub(server);
    restoreEnv("TUILENS_HOME", previousHome);
    restoreEnv("TUILENS_IPC_HANDSHAKE_TIMEOUT_MS", previousTimeout);
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test("请求超时或预取消会立即放弃未完成的 v2 握手", { timeout: 8000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), "tuilens-client-handshake-abort-"));
  const previousHome = process.env.TUILENS_HOME;
  const previousTimeout = process.env.TUILENS_IPC_HANDSHAKE_TIMEOUT_MS;
  process.env.TUILENS_HOME = home;
  process.env.TUILENS_IPC_HANDSHAKE_TIMEOUT_MS = "3000";
  let server: Server | undefined;
  try {
    const paths = runtimePaths();
    await mkdir(paths.home, { recursive: true });
    await writeFile(paths.state, JSON.stringify({ token: "a", pid: process.pid }));
    server = await startIpcStub(paths.socket, (socket) => {
      socket.setEncoding("utf8");
      socket.on("data", () => {});
    });

    const started = performance.now();
    await assert.rejects(request("ping", {}, { autoStart: false, timeoutMs: 100 }), { code: "IPC_TIMEOUT" });
    assert.ok(performance.now() - started < 1000);
    for (let attempt = 0; attempt < 50 && stubSockets.size > 0; attempt += 1) await sleep(10);
    assert.equal(stubSockets.size, 0);

    const controller = new AbortController();
    controller.abort(new Error("pre-cancelled"));
    const cancelledAt = performance.now();
    await assert.rejects(request("ping", {}, { autoStart: false, signal: controller.signal }), { code: "ABORTED" });
    assert.ok(performance.now() - cancelledAt < 100);
    assert.equal(stubSockets.size, 0);
  } finally {
    await closeIpcStub(server);
    restoreEnv("TUILENS_HOME", previousHome);
    restoreEnv("TUILENS_IPC_HANDSHAKE_TIMEOUT_MS", previousTimeout);
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test("请求超时后短命子进程不会等待完整握手超时", { timeout: 8000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), "tuilens-handshake-child-"));
  const previousHome = process.env.TUILENS_HOME;
  process.env.TUILENS_HOME = home;
  let server: Server | undefined;
  try {
    const paths = runtimePaths();
    await mkdir(paths.home, { recursive: true });
    await writeFile(paths.state, JSON.stringify({ token: "a", pid: process.pid }));
    server = await startIpcStub(paths.socket, (socket) => {
      socket.setEncoding("utf8");
      socket.on("data", () => {});
    });
    const script =
      `import { request } from ${JSON.stringify(pathToFileURL(clientModule).href)};\n` +
      `try { await request("ping", {}, { autoStart: false }); } catch (error) { process.stdout.write(error.code ?? "UNKNOWN"); }`;
    const started = performance.now();
    const result = await execute(process.execPath, ["--input-type=module", "-e", script], {
      env: {
        ...process.env,
        TUILENS_HOME: home,
        TUILENS_IPC_TIMEOUT_MS: "100",
        TUILENS_IPC_HANDSHAKE_TIMEOUT_MS: "3000",
      },
      timeout: 5000,
    });
    assert.equal(result.stdout.trim(), "IPC_TIMEOUT");
    assert.ok(performance.now() - started < 1500);
    assert.equal(stubSockets.size, 0);
  } finally {
    await closeIpcStub(server);
    restoreEnv("TUILENS_HOME", previousHome);
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test("一个握手等待者中止不会中断其他共享连接请求", { timeout: 8000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), "tuilens-handshake-shared-"));
  const previousHome = process.env.TUILENS_HOME;
  process.env.TUILENS_HOME = home;
  let server: Server | undefined;
  try {
    const paths = runtimePaths();
    await mkdir(paths.home, { recursive: true });
    const token = randomBytes(16).toString("hex");
    await writeFile(paths.state, JSON.stringify({ token, pid: process.pid }));
    server = await startIpcStub(paths.socket, (socket) => {
      socket.setEncoding("utf8");
      let buffer = "";
      let authenticated = false;
      socket.on("data", (part: string) => {
        buffer += part;
        while (true) {
          const end = buffer.indexOf("\n");
          if (end < 0) return;
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 1);
          const frame = JSON.parse(line) as { type?: string; id?: string };
          if (!authenticated) {
            authenticated = true;
            setTimeout(() => {
              if (!socket.destroyed) {
                socket.write(
                  encodeFrame({
                    type: "auth_ok",
                    version: 2,
                    daemonPid: process.pid,
                    daemonVersion: "test",
                  })
                );
              }
            }, 150);
            continue;
          }
          if (frame.type === "req" && frame.id) {
            socket.write(encodeFrame({ type: "res", id: frame.id, ok: true, data: { pong: true } }));
          }
        }
      });
    });
    const client = new IpcClient(paths);
    const first = client.call("ping", {}, { timeoutMs: 40 });
    const second = client.call("ping", {}, { timeoutMs: 2000 });
    await assert.rejects(first, { code: "IPC_TIMEOUT" });
    assert.deepEqual(await second, { pong: true });
  } finally {
    await closeIpcStub(server);
    restoreEnv("TUILENS_HOME", previousHome);
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test("不可序列化参数不会泄漏在途请求", { timeout: 10000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), "tuilens-serialize-"));
  const previousHome = process.env.TUILENS_HOME;
  process.env.TUILENS_HOME = home;
  let server: Server | undefined;
  try {
    const paths = runtimePaths();
    await mkdir(paths.home, { recursive: true });
    const token = randomBytes(16).toString("hex");
    await writeFile(paths.state, JSON.stringify({ token, pid: process.pid }));
    server = await startV2Stub(
      paths.socket,
      (socket, frame) => socket.write(encodeFrame({ type: "res", id: frame.id, ok: true, data: { pong: true } })),
      token
    );
    const client = new IpcClient(paths);
    const internals = client as unknown as { inflight: Map<string, unknown> };
    await client.call("ping", {});
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    await assert.rejects(client.call("ping", circular), { code: "INVALID_ARGUMENT" });
    assert.equal(internals.inflight.size, 0);
    await assert.rejects(client.call("ping", { value: BigInt(1) }), { code: "INVALID_ARGUMENT" });
    assert.equal(internals.inflight.size, 0);
    await client.call("ping", {});
    assert.equal(internals.inflight.size, 0);
  } finally {
    await closeIpcStub(server);
    restoreEnv("TUILENS_HOME", previousHome);
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test("客户端在 64 个在途请求时快速失败", { timeout: 15000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), "tuilens-client-inflight-limit-"));
  const previousHome = process.env.TUILENS_HOME;
  process.env.TUILENS_HOME = home;
  let server: Server | undefined;
  try {
    const paths = runtimePaths();
    await mkdir(paths.home, { recursive: true });
    const token = randomBytes(16).toString("hex");
    await writeFile(paths.state, JSON.stringify({ token, pid: process.pid }));
    server = await startV2Stub(paths.socket, () => {}, token);
    const client = new IpcClient(paths);
    const internals = client as unknown as { inflight: Map<string, unknown> };
    const controllers = Array.from({ length: MAX_INFLIGHT_PER_CONNECTION }, () => new AbortController());
    const pending = controllers.map((controller) =>
      client.call("ping", {}, { signal: controller.signal, timeoutMs: 8000 }).catch(() => undefined)
    );
    for (let attempt = 0; attempt < 100 && internals.inflight.size < MAX_INFLIGHT_PER_CONNECTION; attempt += 1) {
      await sleep(10);
    }
    assert.equal(internals.inflight.size, MAX_INFLIGHT_PER_CONNECTION);
    await assert.rejects(client.call("ping", {}), { code: "TOO_MANY_INFLIGHT" });
    for (const controller of controllers) controller.abort();
    await Promise.all(pending);
    assert.equal(internals.inflight.size, 0);
  } finally {
    await closeIpcStub(server);
    restoreEnv("TUILENS_HOME", previousHome);
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test("错误 token 与协议版本在鉴权阶段被拒绝", { timeout: 15000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), "tuilens-auth-v2-"));
  const previousHome = process.env.TUILENS_HOME;
  process.env.TUILENS_HOME = home;
  let server: Server | undefined;
  try {
    const paths = runtimePaths();
    await mkdir(paths.home, { recursive: true });
    await writeFile(paths.state, JSON.stringify({ token: "a", pid: process.pid }));
    server = await startV2Stub(paths.socket, () => {}, "b");
    await assert.rejects(request("ping", {}, { autoStart: false }), { code: "UNAUTHORIZED" });
  } finally {
    await closeIpcStub(server);
    restoreEnv("TUILENS_HOME", previousHome);
    await rm(home, { recursive: true, force: true, maxRetries: 5 });
  }
});

test("服务端拒绝旧短连接帧与错误版本", { timeout: 15000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), "tuilens-legacy-reject-"));
  const previousHome = process.env.TUILENS_HOME;
  process.env.TUILENS_HOME = home;
  try {
    await request("ping", {}, { timeoutMs: 5000 });
    const token = await daemonToken();
    const wrongVersion = await RawIpcClient.open(runtimePaths().socket);
    wrongVersion.writeFrame({ type: "auth", version: 1, token });
    const versionError = await wrongVersion.next((frame) => frame.type === "auth_error");
    assert.equal(versionError.type, "auth_error");
    if (versionError.type === "auth_error") assert.equal(versionError.error.code, "PROTOCOL_VERSION");
    await wrongVersion.close();

    const wrongToken = await RawIpcClient.open(runtimePaths().socket);
    wrongToken.writeFrame({ type: "auth", version: 2, token: "00" });
    const tokenError = await wrongToken.next((frame) => frame.type === "auth_error");
    assert.equal(tokenError.type, "auth_error");
    if (tokenError.type === "auth_error") assert.equal(tokenError.error.code, "UNAUTHORIZED");
    await wrongToken.close();

    const legacy = await RawIpcClient.open(runtimePaths().socket);
    legacy.sendRaw(JSON.stringify({ token, method: "ping", params: {} }) + "\n");
    const legacyError = await legacy.next((frame) => frame.type === "auth_error");
    assert.equal(legacyError.type, "auth_error");
    if (legacyError.type === "auth_error") assert.equal(legacyError.error.code, "AUTH_REQUIRED");
    await legacy.close();
  } finally {
    await request("shutdown", {}, { autoStart: false }).catch(() => null);
    restoreEnv("TUILENS_HOME", previousHome);
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test("持久连接支持拆包、粘包和并发多请求", { timeout: 15000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), "tuilens-framing-"));
  const previousHome = process.env.TUILENS_HOME;
  process.env.TUILENS_HOME = home;
  try {
    await request("ping", {}, { timeoutMs: 5000 });
    const token = await daemonToken();
    const client = await RawIpcClient.open(runtimePaths().socket);
    const auth = JSON.stringify({ type: "auth", version: 2, token }) + "\n";
    client.sendRaw(auth.slice(0, 13));
    await sleep(20);
    client.sendRaw(auth.slice(13));
    const authOk = await client.next((frame) => frame.type === "auth_ok" || frame.type === "auth_error");
    assert.equal(authOk.type, "auth_ok");
    if (authOk.type === "auth_ok") {
      assert.equal(authOk.version, 2);
      assert.ok(authOk.daemonPid > 0);
      assert.match(authOk.daemonVersion, /^\d+\.\d+\.\d+/u);
    }

    const pingId = randomUUID();
    const listId = randomUUID();
    const frames =
      JSON.stringify({ type: "req", id: pingId, method: "ping", params: {} }) +
      "\n" +
      JSON.stringify({ type: "req", id: listId, method: "list", params: {} }) +
      "\n";
    client.sendRaw(frames);
    const ping = await client.next((frame) => frame.type === "res" && frame.id === pingId);
    const list = await client.next((frame) => frame.type === "res" && frame.id === listId);
    assert.equal(ping.type, "res");
    assert.equal(list.type, "res");
    if (ping.type === "res") assert.equal(ping.ok, true);
    if (list.type === "res") assert.equal(list.ok, true);
    await client.close();
  } finally {
    await request("shutdown", {}, { autoStart: false }).catch(() => null);
    restoreEnv("TUILENS_HOME", previousHome);
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test("单连接并发在途请求限制为 64", { timeout: 15000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), "tuilens-inflight-limit-"));
  const previousHome = process.env.TUILENS_HOME;
  process.env.TUILENS_HOME = home;
  try {
    await request("ping", {}, { timeoutMs: 5000 });
    const token = await daemonToken();
    const client = await RawIpcClient.open(runtimePaths().socket);
    client.writeFrame({ type: "auth", version: 2, token });
    await client.next((frame) => frame.type === "auth_ok");
    const ids = Array.from({ length: 65 }, () => randomUUID());
    client.sendRaw(ids.map((id) => JSON.stringify({ type: "req", id, method: "ping", params: {} })).join("\n") + "\n");
    const overflow = await client.next((frame) => frame.type === "res" && frame.id === ids[64]!);
    assert.equal(overflow.type, "res");
    if (overflow.type === "res") {
      assert.equal(overflow.ok, false);
      assert.equal(overflow.error?.code, "TOO_MANY_INFLIGHT");
    }
    await client.close();
  } finally {
    await request("shutdown", {}, { autoStart: false }).catch(() => null);
    restoreEnv("TUILENS_HOME", previousHome);
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test("服务端拒绝超过 1 MiB 的单行且守护进程仍可用", { timeout: 15000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), "tuilens-request-limit-"));
  const previousHome = process.env.TUILENS_HOME;
  process.env.TUILENS_HOME = home;
  try {
    await request("ping", {}, { timeoutMs: 5000 });
    const token = await daemonToken();
    const client = await RawIpcClient.open(runtimePaths().socket);
    client.writeFrame({ type: "auth", version: 2, token });
    await client.next((frame) => frame.type === "auth_ok");
    client.sendRaw("x".repeat(MAX_REQUEST_BYTES + 1) + "\n");
    await assert.rejects(client.next(() => true, 3000));
    await request("ping", {}, { timeoutMs: 5000 });
  } finally {
    await request("shutdown", {}, { autoStart: false }).catch(() => null);
    restoreEnv("TUILENS_HOME", previousHome);
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test("按 id 取消只中断目标请求，连接和其他请求继续工作", { timeout: 20000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), "tuilens-cancel-v2-"));
  const previousHome = process.env.TUILENS_HOME;
  process.env.TUILENS_HOME = home;
  try {
    await request("ping", {}, { timeoutMs: 5000 });
    const session = await launchFixture();
    const token = await daemonToken();
    const client = await RawIpcClient.open(runtimePaths().socket);
    client.writeFrame({ type: "auth", version: 2, token });
    await client.next((frame) => frame.type === "auth_ok");
    const waitId = randomUUID();
    const pingId = randomUUID();
    client.sendRaw(
      JSON.stringify({
        type: "req",
        id: waitId,
        method: "wait",
        params: {
          id: session.id,
          conditions: [{ kind: "text", text: "NEVER_APPEARS" }],
          timeoutMs: 10000,
        },
      }) +
        "\n" +
        JSON.stringify({ type: "req", id: pingId, method: "ping", params: {} }) +
        "\n"
    );
    const ping = await client.next((frame) => frame.type === "res" && frame.id === pingId);
    assert.equal(ping.type, "res");
    if (ping.type === "res") assert.equal(ping.ok, true);
    await sleep(100);
    client.writeFrame({ type: "cancel", id: waitId });
    const cancelled = await client.next((frame) => frame.type === "res" && frame.id === waitId);
    assert.equal(cancelled.type, "res");
    if (cancelled.type === "res") {
      assert.equal(cancelled.ok, false);
      assert.equal(cancelled.error?.code, "ABORTED");
    }
    const afterId = randomUUID();
    client.writeFrame({ type: "req", id: afterId, method: "ping", params: {} });
    const after = await client.next((frame) => frame.type === "res" && frame.id === afterId);
    assert.equal(after.type, "res");
    if (after.type === "res") assert.equal(after.ok, true);
    await client.close();
    await request("close", { id: session.id });
  } finally {
    await request("shutdown", {}, { autoStart: false }).catch(() => null);
    restoreEnv("TUILENS_HOME", previousHome);
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test("重复请求 ID 关闭连接且不会产生两个终态响应", { timeout: 20000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), "tuilens-duplicate-id-"));
  const previousHome = process.env.TUILENS_HOME;
  process.env.TUILENS_HOME = home;
  try {
    await request("ping", {}, { timeoutMs: 5000 });
    const session = await launchFixture();
    const token = await daemonToken();
    const client = await RawIpcClient.open(runtimePaths().socket);
    client.writeFrame({ type: "auth", version: 2, token });
    await client.next((frame) => frame.type === "auth_ok");
    const id = randomUUID();
    client.writeFrame({
      type: "req",
      id,
      method: "wait",
      params: {
        id: session.id,
        conditions: [{ kind: "text", text: "NEVER_APPEARS" }],
        timeoutMs: 10000,
      },
    });
    await sleep(50);
    client.writeFrame({ type: "req", id, method: "ping", params: {} });
    await assert.rejects(
      client.next(() => true, 1500),
      /closed|IPC connection/u
    );
    await request("close", { id: session.id });
  } finally {
    await request("shutdown", {}, { autoStart: false }).catch(() => null);
    restoreEnv("TUILENS_HOME", previousHome);
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test("watch 由服务端主动推送变化帧并正常超时结束", { timeout: 20000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), "tuilens-watch-v2-"));
  const previousHome = process.env.TUILENS_HOME;
  process.env.TUILENS_HOME = home;
  try {
    await request("ping", {}, { timeoutMs: 5000 });
    const session = await launchFixture();
    await request("wait", {
      id: session.id,
      conditions: [{ kind: "text", text: "TUILENS_READY" }],
      timeoutMs: 5000,
    });
    const events: IpcEventName[] = [];
    const watch = request(
      "watch",
      { id: session.id, intervalMs: 50, timeoutMs: 900 },
      {
        onEvent: (event, data) => {
          events.push(event);
          if (event === "frame") {
            const observation = data as { snapshot?: { cells?: unknown } };
            assert.ok(observation.snapshot);
            assert.equal(Object.hasOwn(observation.snapshot!, "cells"), false);
          }
        },
      }
    );
    await sleep(150);
    await request("input", { id: session.id, action: { type: "text", text: "PING" } });
    const result = (await watch) as { frames: number; timedOut: boolean };
    assert.equal(result.timedOut, true);
    assert.ok(result.frames >= 2);
    assert.ok(events.filter((event) => event === "frame").length >= 2);
    await request("close", { id: session.id });
  } finally {
    await request("shutdown", {}, { autoStart: false }).catch(() => null);
    restoreEnv("TUILENS_HOME", previousHome);
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test("watch 在进程退出时推送 exit 事件和退出码", { timeout: 20000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), "tuilens-watch-exit-"));
  const previousHome = process.env.TUILENS_HOME;
  process.env.TUILENS_HOME = home;
  try {
    await request("ping", {}, { timeoutMs: 5000 });
    const session = (await request("launch", {
      command: process.execPath,
      args: ["-e", "process.stdout.write('WATCH_EXIT\\n');setTimeout(()=>process.exit(3),80)"],
      cols: 40,
      rows: 8,
    })) as SessionInfo;
    const events: { event: IpcEventName; data: unknown }[] = [];
    const result = (await request(
      "watch",
      { id: session.id, intervalMs: 50, timeoutMs: 0 },
      {
        onEvent: (event, data) => {
          events.push({ event, data });
        },
      }
    )) as { frames: number; timedOut: boolean };
    assert.equal(result.timedOut, false);
    assert.ok(result.frames >= 1);
    const exit = events.find((entry) => entry.event === "exit");
    assert.ok(exit);
    assert.equal((exit.data as { exitCode?: number }).exitCode, 3);
    await request("close", { id: session.id });
  } finally {
    await request("shutdown", {}, { autoStart: false }).catch(() => null);
    restoreEnv("TUILENS_HOME", previousHome);
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test("scenario 与 perf 通过同一连接推送真实 progress", { timeout: 30000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), "tuilens-progress-v2-"));
  const previousHome = process.env.TUILENS_HOME;
  process.env.TUILENS_HOME = home;
  try {
    await request("ping", {}, { timeoutMs: 5000 });
    const scenarioProgress: OperationProgress[] = [];
    const scenario = (await request(
      "scenario",
      {
        specification: {
          version: 1,
          launch: { command: process.execPath, args: [fixture], cols: 40, rows: 8 },
          steps: [
            {
              type: "wait",
              name: "ready",
              conditions: [{ kind: "text", text: "TUILENS_READY" }],
              timeoutMs: 5000,
            },
          ],
        },
      },
      { onEvent: (event, data) => event === "progress" && scenarioProgress.push(data as OperationProgress) }
    )) as { pass: boolean };
    assert.equal(scenario.pass, true);
    assert.ok(scenarioProgress.some((progress) => progress.kind === "scenario" && progress.current === 1));

    const perfProgress: OperationProgress[] = [];
    const perf = (await request(
      "perf",
      {
        specification: {
          version: 1,
          launch: { command: process.execPath, args: [fixture], cols: 40, rows: 8 },
          ready: [{ kind: "text", text: "TUILENS_READY" }],
          rounds: 1,
          repeats: 1,
          warmupRounds: 0,
          measure: { processTree: false },
          phases: [
            {
              name: "interaction",
              samples: [
                {
                  name: "ping",
                  input: { type: "text", text: "PING" },
                  observe: [{ kind: "text", text: "INPUT_RECEIVED" }],
                  timeoutMs: 5000,
                },
              ],
            },
          ],
        },
      },
      { onEvent: (event, data) => event === "progress" && perfProgress.push(data as OperationProgress) }
    )) as { pass: boolean; errors: unknown[] };
    assert.equal(perf.pass, true);
    assert.deepEqual(perf.errors, []);
    assert.ok(
      perfProgress.some((progress) => progress.kind === "perf" && progress.current === 1 && progress.total === 1)
    );
  } finally {
    await request("shutdown", {}, { autoStart: false }).catch(() => null);
    restoreEnv("TUILENS_HOME", previousHome);
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test("短命 CLI 使用持久连接后仍能正常退出", { timeout: 10000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), "tuilens-cli-exit-"));
  const env = { ...process.env, TUILENS_HOME: home };
  try {
    const started = performance.now();
    const result = await execute(process.execPath, [cli, "ping"], { env, timeout: 5000 });
    assert.ok(performance.now() - started < 4000);
    const payload = JSON.parse(result.stdout) as { ok: boolean };
    assert.equal(payload.ok, true);
  } finally {
    await execute(process.execPath, [cli, "shutdown"], { env, timeout: 10000 }).catch(() => null);
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test("半开连接在握手超时后释放", { timeout: 15000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), "tuilens-half-open-"));
  const previousHome = process.env.TUILENS_HOME;
  const previousHandshake = process.env.TUILENS_IPC_HANDSHAKE_TIMEOUT_MS;
  process.env.TUILENS_HOME = home;
  process.env.TUILENS_IPC_HANDSHAKE_TIMEOUT_MS = "120";
  let daemonPid: number | null = null;
  try {
    const paths = runtimePaths();
    await request("ping", {}, { timeoutMs: 5000 });
    daemonPid = (JSON.parse(await readFile(paths.state, "utf8")) as { pid: number }).pid;
    const started = performance.now();
    await new Promise<void>((resolve, reject) => {
      const socket = connect(paths.socket);
      let connected = false;
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error("half-open connection stayed open"));
      }, 2000);
      socket.once("connect", () => {
        connected = true;
        socket.write("{");
      });
      socket.once("error", (error) => {
        if (!connected) {
          clearTimeout(timer);
          reject(error);
        }
      });
      socket.once("close", () => {
        clearTimeout(timer);
        if (connected) resolve();
        else reject(new Error("connection closed before connect"));
      });
    });
    assert.ok(performance.now() - started >= 80);
  } finally {
    await request("shutdown", {}, { autoStart: false }).catch(() => null);
    if (daemonPid !== null) {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        try {
          process.kill(daemonPid, 0);
        } catch {
          break;
        }
        await sleep(50);
      }
    }
    restoreEnv("TUILENS_HOME", previousHome);
    restoreEnv("TUILENS_IPC_HANDSHAKE_TIMEOUT_MS", previousHandshake);
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test("macOS 强杀守护进程后残留 socket 可恢复", {
  skip: process.platform !== "darwin",
  timeout: 30000,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), "tuilens-macos-stale-socket-"));
  const env = { ...process.env, TUILENS_HOME: home };
  const ping = async (): Promise<{ pid: number }> => {
    const result = await execute(process.execPath, [cli, "ping"], { env, timeout: 15000 });
    const payload = JSON.parse(result.stdout) as { ok: boolean; data: { pid: number } };
    assert.equal(payload.ok, true);
    return payload.data;
  };
  try {
    const first = await ping();
    process.kill(first.pid, "SIGKILL");
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        process.kill(first.pid, 0);
      } catch {
        break;
      }
      await sleep(50);
    }
    const restarted = await ping();
    assert.notEqual(restarted.pid, first.pid);
  } finally {
    await execute(process.execPath, [cli, "shutdown"], { env, timeout: 10000 }).catch(() => null);
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test("独立归属的 IPC 客户端在空闲连接断开后继续拥有会话", { timeout: 25000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), "tuilens-owner-reconnect-"));
  const previousHome = process.env.TUILENS_HOME;
  process.env.TUILENS_HOME = home;
  const sockets: Socket[] = [];
  const connector = ((path: string) => {
    const socket = connect(path);
    sockets.push(socket);
    return socket;
  }) as typeof connect;
  try {
    await request("ping", {}, { timeoutMs: 5000 });
    const paths = runtimePaths();
    const owner = new IpcClient(paths, connector, randomUUID());
    const recipient = new IpcClient(paths, undefined, randomUUID());
    const { id } = (await owner.call("launch", { command: process.execPath, args: [fixture] })) as SessionInfo;
    const oldSocket = sockets[0]!;
    const disconnected = new Promise<void>((resolve) => oldSocket.once("close", () => resolve()));
    oldSocket.destroy();
    await disconnected;
    assert.deepEqual(
      ((await owner.call("list", {})) as SessionInfo[]).map((row) => row.id),
      [id]
    );
    assert.equal(sockets.length, 2);
    assert.deepEqual(await recipient.call("list", {}), []);

    const { token } = (await owner.call("handoff", { id })) as { token: string };
    await owner.call("wait", { id, conditions: [{ kind: "text", text: "TUILENS_READY" }], timeoutMs: 5000 });
    let onReady!: () => void;
    const ready = new Promise<void>((resolve) => {
      onReady = resolve;
    });
    const wait = owner.call(
      "wait",
      { id, conditions: [{ kind: "text", text: "INPUT_RECEIVED" }], timeoutMs: 5000 },
      {
        onEvent: (event) => {
          if (event === "progress") onReady();
        },
      }
    );
    await Promise.race([ready, wait]);
    await assert.rejects(recipient.call("adopt", { id, token }), { code: "SESSION_BUSY" });
    await owner.call("input", { id, action: { type: "text", text: "PING" } });
    await wait;
    assert.equal(((await recipient.call("adopt", { id, token })) as SessionInfo).id, id);
    assert.deepEqual(await owner.call("releaseOwned", {}), { released: 0 });
    assert.deepEqual(await recipient.call("releaseOwned", {}), { released: 1 });
    assert.deepEqual(await owner.call("list", { includeAll: true }), []);
    await assert.rejects(recipient.call("shutdown", {}), { code: "UNAUTHORIZED" });
    await assert.rejects(request("releaseOwned"), { code: "UNAUTHORIZED" });
    await request("ping", {}, { autoStart: false });
  } finally {
    await request("shutdown", {}, { autoStart: false }).catch(() => null);
    restoreEnv("TUILENS_HOME", previousHome);
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

async function withScopedIpcStub(
  handle: (socket: Socket, frame: ClientFrame) => void,
  exercise: (client: IpcClient) => Promise<void>
): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), "tuilens-scoped-stub-"));
  const previousHome = process.env.TUILENS_HOME;
  process.env.TUILENS_HOME = home;
  let server: Server | undefined;
  try {
    const paths = runtimePaths();
    await writeFile(paths.state, JSON.stringify({ token: "aa", pid: process.pid }));
    server = await startIpcStub(paths.socket, (socket) => {
      const reader = createInterface({ input: socket });
      reader.on("line", (line) => handle(socket, JSON.parse(line) as ClientFrame));
      socket.once("close", () => reader.close());
    });
    await exercise(new IpcClient(paths, undefined, randomUUID()));
  } finally {
    await closeIpcStub(server);
    restoreEnv("TUILENS_HOME", previousHome);
    await rm(home, { recursive: true, force: true, maxRetries: 5 });
  }
}

test("独立归属握手遇到旧 daemon 时拒绝发送业务请求", async (t) => {
  for (const response of [
    { type: "auth_ok", version: 2, daemonPid: process.pid, daemonVersion: "test" },
    { type: "auth_error", error: errorFrame("PROTOCOL_ERROR") },
  ] as const) {
    await t.test(response.type, async () => {
      const requests: string[] = [];
      await withScopedIpcStub(
        (socket, frame) => {
          requests.push(frame.type);
          if (frame.type === "auth") socket.write(encodeFrame(response));
          else socket.end();
        },
        async (client) => {
          await assert.rejects(client.call("list", {}, { timeoutMs: 2000 }), { code: "PROTOCOL_VERSION" });
          assert.deepEqual(requests, ["auth"]);
        }
      );
    });
  }
});

test("独立归属客户端取消获取会话后清理迟到的成功响应", { timeout: 10000 }, async (t) => {
  for (const method of ["launch", "adopt"] as const) {
    await t.test(method, async () => {
      const sessionId = randomUUID();
      const events = new EventEmitter();
      const requested = once(events, "acquire");
      const cancelled = once(events, "cancel");
      const cleaned = once(events, "cleaned");
      const attempts: { method: string; params: unknown }[] = [];
      await withScopedIpcStub(
        (socket, frame) => {
          if (frame.type === "auth") {
            socket.write(
              encodeFrame({ type: "auth_ok", version: 2, daemonPid: process.pid, daemonVersion: "test", scoped: true })
            );
          } else if (frame.type === "cancel") {
            events.emit("cancel", frame.id);
          } else if (frame.method === method) {
            events.emit("acquire", socket, frame.id);
          } else {
            attempts.push({ method: frame.method, params: frame.params });
            if (attempts.length === 1) {
              socket.write(encodeFrame({ type: "res", id: frame.id, ok: false, error: errorFrame("INTERNAL") }));
            } else {
              socket.write(encodeFrame({ type: "res", id: frame.id, ok: true, data: { released: true } }));
              events.emit("cleaned");
            }
          }
        },
        async (client) => {
          const controller = new AbortController();
          const acquisition = client.call(method, {}, { signal: controller.signal });
          const [socket, requestId] = (await requested) as [Socket, string];
          controller.abort();
          await assert.rejects(acquisition, { code: "ABORTED" });
          assert.deepEqual(await cancelled, [requestId]);
          socket.write(encodeFrame({ type: "res", id: requestId, ok: true, data: { id: sessionId } }));
          await cleaned;
          const expected = { method: "releaseAcquisition", params: { id: sessionId, acquisitionId: requestId } };
          assert.deepEqual(attempts, [expected, expected]);
        }
      );
    });
  }
});

test("会话回到原持有者后，迟到的回收只匹配原获取请求", { timeout: 20000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), "tuilens-owner-roundtrip-"));
  const previousHome = process.env.TUILENS_HOME;
  process.env.TUILENS_HOME = home;
  let raw: RawIpcClient | undefined;
  try {
    await request("ping", {}, { timeoutMs: 5000 });
    const paths = runtimePaths();
    const ownerId = randomUUID();
    const owner = new IpcClient(paths, undefined, ownerId);
    const recipient = new IpcClient(paths, undefined, randomUUID());
    const channel = await RawIpcClient.open(paths.socket);
    raw = channel;
    channel.writeFrame({ type: "auth", version: 2, token: await daemonToken(), ownerId });
    const auth = await channel.next((frame) => frame.type === "auth_ok" || frame.type === "auth_error");
    assert.ok(auth.type === "auth_ok" && auth.scoped);

    async function acquire(method: "launch" | "adopt", params: object) {
      const requestId = randomUUID();
      channel.writeFrame({ type: "req", id: requestId, method, params });
      const response = await channel.next((frame) => frame.type === "res" && frame.id === requestId);
      assert.ok(response.type === "res" && response.ok);
      return { acquisitionId: requestId, session: response.data as SessionInfo };
    }
    const initial = await acquire("launch", { command: process.execPath, args: [fixture] });
    const id = initial.session.id;
    const acquisitions = [initial.acquisitionId];
    for (let round = 0; round < 2; round++) {
      const outgoing = (await owner.call("handoff", { id })) as { token: string };
      await recipient.call("adopt", { id, token: outgoing.token });
      const incoming = (await recipient.call("handoff", { id })) as { token: string };
      const returned = await acquire("adopt", { id, token: incoming.token });
      assert.equal(returned.session.id, id);
      acquisitions.push(returned.acquisitionId);
    }

    const current = { id, acquisitionId: acquisitions[2]! };
    for (const acquisitionId of acquisitions.slice(0, -1)) {
      assert.deepEqual(await owner.call("releaseAcquisition", { id, acquisitionId }), { released: false });
    }
    assert.deepEqual(await recipient.call("releaseAcquisition", current), { released: false });
    assert.deepEqual(
      ((await owner.call("list", {})) as SessionInfo[]).map((row) => row.id),
      [id]
    );
    await owner.call("wait", { id, conditions: [{ kind: "text", text: "TUILENS_READY" }], timeoutMs: 5000 });
    assert.deepEqual(await owner.call("releaseAcquisition", current), { released: true });
    assert.deepEqual(await owner.call("releaseAcquisition", current), { released: false });
    assert.deepEqual(await owner.call("list", {}), []);
  } finally {
    await raw?.close();
    await request("shutdown", {}, { autoStart: false }).catch(() => null);
    restoreEnv("TUILENS_HOME", previousHome);
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
