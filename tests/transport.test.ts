import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { connect, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { isDaemonUnavailable, request, sleepWithSignal } from "../src/transport/client.js";
import { runtimePaths } from "../src/transport/paths.js";

const execute = promisify(execFile);
const cli = fileURLToPath(new URL("../src/interfaces/cli.js", import.meta.url));

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

async function startIpcStub(socketPath: string, handler: (socket: Socket) => void): Promise<Server> {
  const server = createServer(handler);
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
  await new Promise<void>((resolve) => server.close(() => resolve()));
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
    // 模拟守护进程被强杀后留下的陈旧启动锁和清理锁，并发客户端必须自行接管且只启动一个实例。
    for (const name of ["daemon-start.lock", "daemon-start.lock.cleanup"]) {
      const staleLock = join(home, name);
      await writeFile(staleLock, JSON.stringify({ pid: process.pid, token: `stale-${name}`, at: 0 }));
      await utimes(staleLock, new Date(0), new Date(0));
    }
    const responses = await Promise.all(Array.from({ length: 5 }, () => call("ping")));
    assert.ok(responses.every((r) => r.ok));
    assert.equal(new Set(responses.map((r) => r.data.pid)).size, 1);
    assert.equal(existsSync(join(home, "daemon-start.lock")), false);
    assert.equal(existsSync(join(home, "daemon-start.lock.cleanup")), false);
    assert.equal(typeof responses[0]!.data.version, "string");
    assert.equal(responses[0]!.data.sessions, 0);
    assert.equal(responses[0]!.data.pendingLaunches, 0);
    assert.equal(responses[0]!.data.offline, 0);
    assert.equal(responses[0]!.data.disposed, false);
    assert.ok(responses[0]!.data.uptimeMs >= 0);
    await call("shutdown");
    // shutdown 返回后端点关闭异步完成；探测旧 PID 消失再验证重启。
    for (let i = 0; i < 50; i += 1) {
      try {
        process.kill(responses[0]!.data.pid, 0);
      } catch {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const restarted = await call("ping");
    assert.notEqual(restarted.data.pid, responses[0]!.data.pid);
  } finally {
    await call("shutdown").catch(() => undefined);
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test("shutdown 关闭窗口内立即请求会等待旧实例并自动重启", { timeout: 30000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), "tuilens-shutdown-restart-"));
  const env = { ...process.env, TUILENS_HOME: home };
  const call = async (command: string): Promise<{ ok: boolean; data: { pid: number } }> => {
    const result = await execute(process.execPath, [cli, command], { env, timeout: 15000 });
    return JSON.parse(result.stdout) as { ok: boolean; data: { pid: number } };
  };
  try {
    const first = await call("ping");
    await call("shutdown");
    const restarted = await call("ping");
    assert.equal(restarted.ok, true);
    assert.notEqual(restarted.data.pid, first.data.pid);
  } finally {
    await call("shutdown").catch(() => undefined);
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
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
    await writeFile(paths.state, JSON.stringify({ token: "test-token", pid: process.pid }));
    assert.equal(isDaemonUnavailable({ code: "IPC_CLOSED" }), true);
    assert.equal(isDaemonUnavailable({ code: "ECONNRESET" }), true);
    assert.equal(isDaemonUnavailable({ code: "EPIPE" }), true);

    server = await startIpcStub(paths.socket, (socket) => socket.destroy());
    await assert.rejects(request("ping", {}, { autoStart: false }), { code: "DAEMON_UNAVAILABLE" });
    await closeIpcStub(server);
    server = undefined;

    server = await startIpcStub(paths.socket, (socket) => {
      let buffer = "";
      socket.setEncoding("utf8");
      socket.on("data", (part: string) => {
        buffer += part;
        if (!buffer.includes("\n")) return;
        socket.end(JSON.stringify({ ok: false, error: { code: "SHUTTING_DOWN", message: "服务正在关闭" } }) + "\n");
      });
    });
    await assert.rejects(request("ping", {}, { autoStart: false }), { code: "DAEMON_UNAVAILABLE" });
  } finally {
    await closeIpcStub(server);
    restoreEnv("TUILENS_HOME", previousHome);
    await rm(home, { recursive: true, force: true, maxRetries: 5 });
  }
});

test("AbortSignal 中断守护进程启动轮询", { timeout: 10000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), "tuilens-abort-start-"));
  const previousHome = process.env.TUILENS_HOME;
  process.env.TUILENS_HOME = home;
  let server: Server | undefined;
  try {
    const paths = runtimePaths();
    await mkdir(paths.home, { recursive: true });
    await writeFile(paths.state, JSON.stringify({ token: "test-token", pid: process.pid }));
    server = await startIpcStub(paths.socket, (socket) => {
      let buffer = "";
      socket.setEncoding("utf8");
      socket.on("data", (part: string) => {
        buffer += part;
        if (!buffer.includes("\n")) return;
        socket.end(JSON.stringify({ ok: false, error: { code: "SHUTTING_DOWN", message: "服务正在关闭" } }) + "\n");
      });
    });
    const controller = new AbortController();
    const started = performance.now();
    const timer = setTimeout(() => controller.abort(), 200);
    try {
      await assert.rejects(request("ping", {}, { signal: controller.signal }), { code: "ABORTED" });
      assert.ok(performance.now() - started < 2000);
    } finally {
      clearTimeout(timer);
    }
  } finally {
    await closeIpcStub(server);
    restoreEnv("TUILENS_HOME", previousHome);
    await rm(home, { recursive: true, force: true, maxRetries: 5 });
  }
});

test("半开连接在请求行超时后释放", { timeout: 15000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), "tuilens-half-open-"));
  const previousHome = process.env.TUILENS_HOME;
  const previousHandshake = process.env.TUILENS_IPC_HANDSHAKE_TIMEOUT_MS;
  const previousIpc = process.env.TUILENS_IPC_TIMEOUT_MS;
  process.env.TUILENS_HOME = home;
  process.env.TUILENS_IPC_HANDSHAKE_TIMEOUT_MS = "120";
  delete process.env.TUILENS_IPC_TIMEOUT_MS;
  let daemonPid: number | undefined;
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
    await request("shutdown", {}, { autoStart: false }).catch(() => undefined);
    if (daemonPid) {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        try {
          process.kill(daemonPid, 0);
        } catch {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    restoreEnv("TUILENS_HOME", previousHome);
    restoreEnv("TUILENS_IPC_HANDSHAKE_TIMEOUT_MS", previousHandshake);
    restoreEnv("TUILENS_IPC_TIMEOUT_MS", previousIpc);
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
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const restarted = await ping();
    assert.notEqual(restarted.pid, first.pid);
  } finally {
    await execute(process.execPath, [cli, "shutdown"], { env, timeout: 10000 }).catch(() => undefined);
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
