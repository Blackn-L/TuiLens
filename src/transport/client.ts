import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, stat, unlink, type FileHandle } from "node:fs/promises";
import { connect } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { TuiLensError } from "../core/errors.js";
import type { Method } from "../interfaces/schemas.js";
import { runtimePaths, type RuntimePaths } from "./paths.js";

const START_LOCK_STALE_MS = 30_000;
const START_LOCK_WAIT_MS = 20_000;
const START_LOCK_POLL_MS = 50;
const CLEANUP_LOCK_STALE_MS = 5_000;
const CLEANUP_LOCK_WAIT_MS = 5_000;
const CLEANUP_LOCK_POLL_MS = 25;
const START_ATTEMPTS = 100;
const START_RETRY_MS = 100;

function errorCode(error: unknown): string | undefined {
  if (error instanceof TuiLensError) return error.code;
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

/** 缺失状态文件、拒绝连接或端点提前关闭都表示没有可控制的本机服务。 */
export function isDaemonUnavailable(error: unknown): boolean {
  const code = errorCode(error);
  return (
    code === "DAEMON_UNAVAILABLE" ||
    code === "IPC_CLOSED" ||
    code === "ENOENT" ||
    code === "ECONNREFUSED" ||
    code === "ECONNRESET" ||
    code === "ENOTSOCK"
  );
}

function isStartableFailure(error: unknown): boolean {
  const code = errorCode(error);
  return (
    code === "DAEMON_UNAVAILABLE" ||
    code === "ENOENT" ||
    code === "ECONNREFUSED" ||
    code === "ENOTSOCK" ||
    code === "SHUTTING_DOWN"
  );
}

interface LockState {
  pid: number;
  token: string;
  at: number;
}

async function readLockState(path: string): Promise<LockState | undefined> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as Partial<LockState>;
    if (
      Number.isInteger(value.pid) &&
      (value.pid as number) > 0 &&
      typeof value.token === "string" &&
      typeof value.at === "number"
    ) {
      return { pid: value.pid as number, token: value.token, at: value.at };
    }
  } catch {
    /* 锁可能刚被创建或释放。 */
  }
  return undefined;
}

async function lockIsStale(path: string, staleMs: number): Promise<boolean> {
  let age: number;
  try {
    age = Date.now() - (await stat(path)).mtimeMs;
  } catch (error) {
    return errorCode(error) === "ENOENT";
  }
  const state = await readLockState(path);
  if (state) {
    try {
      process.kill(state.pid, 0);
      // PID 可能已被无关进程复用；超长存活的锁按年龄兜底回收。
      return age > staleMs * 4;
    } catch (error) {
      const code = errorCode(error);
      if (code === "EPERM") return false;
      if (code === "ESRCH") return true;
    }
  }
  return age > staleMs;
}

async function unlinkIfOwner(path: string, token: string): Promise<boolean> {
  const before = await stat(path).catch(() => undefined);
  if (!before) return false;
  const state = await readLockState(path);
  if (!state || state.token !== token) return false;
  const after = await stat(path).catch(() => undefined);
  if (!after || before.dev !== after.dev || before.ino !== after.ino) return false;
  try {
    await unlink(path);
    return true;
  } catch (error) {
    return errorCode(error) === "ENOENT";
  }
}

async function fileIdentity(path: string): Promise<{ dev: number; ino: number } | undefined> {
  try {
    const info = await lstat(path);
    return { dev: info.dev, ino: info.ino };
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  }
}

async function handleIdentity(handle: FileHandle): Promise<{ dev: number; ino: number } | undefined> {
  try {
    const info = await handle.stat();
    return { dev: info.dev, ino: info.ino };
  } catch {
    return undefined;
  }
}

async function unlinkIfIdentity(path: string, identity: { dev: number; ino: number }): Promise<boolean> {
  const current = await fileIdentity(path);
  if (!current || current.dev !== identity.dev || current.ino !== identity.ino) return false;
  try {
    await unlink(path);
    return true;
  } catch (error) {
    return errorCode(error) === "ENOENT";
  }
}

async function withCleanupLock<T>(path: string, signal: AbortSignal | undefined, task: () => Promise<T>): Promise<T> {
  const deadline = performance.now() + CLEANUP_LOCK_WAIT_MS;
  while (true) {
    if (signal?.aborted) throw new TuiLensError("ABORTED", "操作已取消");
    let handle: FileHandle;
    try {
      handle = await open(path, "wx", 0o600);
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
      if (await lockIsStale(path, CLEANUP_LOCK_STALE_MS)) {
        const stale = await readLockState(path);
        // 给其他清理者让出窗口，再按 token 复核，避免删除刚建立的新清理锁。
        try {
          await sleep(10, signal ? { signal } : {});
        } catch {
          throw new TuiLensError("ABORTED", "操作已取消");
        }
        if (stale) await unlinkIfOwner(path, stale.token);
        else {
          const identity = await fileIdentity(path);
          if (identity && (await lockIsStale(path, CLEANUP_LOCK_STALE_MS))) {
            await unlinkIfIdentity(path, identity).catch(() => undefined);
          }
        }
        continue;
      }
      if (performance.now() >= deadline) {
        throw new TuiLensError("DAEMON_START_FAILED", `等待本机服务清理锁超时，请查看 ${path}`);
      }
      try {
        await sleep(CLEANUP_LOCK_POLL_MS, signal ? { signal } : {});
      } catch {
        throw new TuiLensError("ABORTED", "操作已取消");
      }
      continue;
    }
    const token = randomUUID();
    let wrote = false;
    try {
      await handle.writeFile(JSON.stringify({ pid: process.pid, token, at: Date.now() }), "utf8");
      wrote = true;
      return await task();
    } finally {
      const identity = wrote ? undefined : await handleIdentity(handle);
      await handle.close().catch(() => undefined);
      if (wrote) await unlinkIfOwner(path, token).catch(() => undefined);
      else if (identity) await unlinkIfIdentity(path, identity).catch(() => undefined);
    }
  }
}

async function removeStaleStartLock(paths: RuntimePaths, signal: AbortSignal | undefined): Promise<void> {
  await withCleanupLock(`${paths.startLock}.cleanup`, signal, async () => {
    if (!(await lockIsStale(paths.startLock, START_LOCK_STALE_MS))) return;
    const stale = await readLockState(paths.startLock);
    if (stale) await unlinkIfOwner(paths.startLock, stale.token);
    else {
      const identity = await fileIdentity(paths.startLock);
      if (identity) await unlinkIfIdentity(paths.startLock, identity);
    }
  });
}

/** 用 O_CREAT|O_EXCL 的原子文件锁串行化守护进程启动；持有者退出后锁可恢复。 */
async function withStartLock<T>(
  paths: RuntimePaths,
  signal: AbortSignal | undefined,
  task: () => Promise<T>
): Promise<T> {
  await mkdir(paths.home, { recursive: true, mode: 0o700 });
  const deadline = performance.now() + START_LOCK_WAIT_MS;
  while (true) {
    if (signal?.aborted) throw new TuiLensError("ABORTED", "操作已取消");
    let handle: FileHandle;
    try {
      handle = await open(paths.startLock, "wx", 0o600);
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
      if (await lockIsStale(paths.startLock, START_LOCK_STALE_MS)) {
        await removeStaleStartLock(paths, signal);
        continue;
      }
      if (performance.now() >= deadline) {
        throw new TuiLensError("DAEMON_START_FAILED", `等待本机服务启动锁超时，请查看 ${paths.log}`);
      }
      try {
        await sleep(START_LOCK_POLL_MS, signal ? { signal } : {});
      } catch {
        throw new TuiLensError("ABORTED", "操作已取消");
      }
      continue;
    }
    const token = randomUUID();
    let wrote = false;
    try {
      await handle.writeFile(JSON.stringify({ pid: process.pid, token, at: Date.now() }), "utf8");
      wrote = true;
      return await task();
    } finally {
      const identity = wrote ? undefined : await handleIdentity(handle);
      await handle.close().catch(() => undefined);
      if (wrote) await unlinkIfOwner(paths.startLock, token).catch(() => undefined);
      else if (identity) await unlinkIfIdentity(paths.startLock, identity).catch(() => undefined);
    }
  }
}

export async function request(
  method: Method,
  params: unknown = {},
  options: { autoStart?: boolean; signal?: AbortSignal; timeoutMs?: number } = {}
): Promise<unknown> {
  const paths = runtimePaths();
  let token = "";
  const getToken = async (): Promise<string> => {
    let state: { token?: unknown };
    try {
      state = JSON.parse(await readFile(paths.state, "utf8")) as { token?: unknown };
    } catch (error) {
      if (isDaemonUnavailable(error) || error instanceof SyntaxError) {
        throw new TuiLensError(
          "DAEMON_UNAVAILABLE",
          "本机服务状态文件不可用",
          { reason: error instanceof SyntaxError ? "invalid JSON" : errorCode(error) },
          "The local daemon state file is unavailable."
        );
      }
      throw error;
    }
    if (typeof state.token !== "string") {
      throw new TuiLensError(
        "DAEMON_UNAVAILABLE",
        "本机服务状态文件无效",
        undefined,
        "The local daemon state file is invalid."
      );
    }
    return state.token;
  };
  const configuredTimeout = Number(process.env.TUILENS_IPC_TIMEOUT_MS);
  const timeoutMs =
    options.timeoutMs ?? (Number.isFinite(configuredTimeout) && configuredTimeout > 0 ? configuredTimeout : 0);
  const send = (command: string, payload: unknown, timeout: number): Promise<unknown> =>
    new Promise((resolve, reject) => {
      if (options.signal?.aborted) {
        reject(new TuiLensError("ABORTED", "操作已取消"));
        return;
      }
      const socket = connect(paths.socket);
      let text = "";
      let bytes = 0;
      const abort = () => socket.destroy(new TuiLensError("ABORTED", "操作已取消"));
      options.signal?.addEventListener("abort", abort, { once: true });
      const cleanup = () => options.signal?.removeEventListener("abort", abort);
      socket.setEncoding("utf8");
      if (timeout > 0)
        socket.setTimeout(timeout, () => socket.destroy(new TuiLensError("IPC_TIMEOUT", "本机服务响应超时")));
      socket.once("connect", () => socket.write(JSON.stringify({ token, method: command, params: payload }) + "\n"));
      socket.on("data", (part: string) => {
        text += part;
        bytes += Buffer.byteLength(part);
        if (bytes > 64 * 1024 * 1024) {
          socket.destroy(new TuiLensError("RESPONSE_LIMIT", "响应超过大小限制"));
          return;
        }
        const end = text.indexOf("\n");
        if (end < 0) return;
        try {
          const response = JSON.parse(text.slice(0, end)) as {
            ok: boolean;
            data?: unknown;
            error?: { code: string; message: string; details?: unknown };
          };
          if (!response.ok)
            reject(
              new TuiLensError(
                response.error?.code ?? "REMOTE_ERROR",
                response.error?.message ?? "操作失败",
                response.error?.details
              )
            );
          else resolve(response.data);
        } catch (error) {
          reject(error);
        }
        socket.destroy();
      });
      socket.once("error", reject);
      socket.once("close", () => {
        cleanup();
        reject(new TuiLensError("IPC_CLOSED", "本机服务连接已关闭"));
      });
    });
  const unavailable = (error: unknown): TuiLensError => {
    if (error instanceof TuiLensError && error.code === "DAEMON_UNAVAILABLE") return error;
    return new TuiLensError(
      "DAEMON_UNAVAILABLE",
      "本机服务未运行或无法连接",
      { reason: errorCode(error) },
      "The local daemon is not running or cannot be reached."
    );
  };
  const call = async (command: string, payload: unknown, timeout: number): Promise<unknown> => {
    if (!token) token = await getToken();
    try {
      return await send(command, payload, timeout);
    } catch (error) {
      if (!(error instanceof TuiLensError) || error.code !== "UNAUTHORIZED") throw error;
      // 守护进程重启会更换 token；认证在派发前失败，因此可安全刷新后重试一次。
      token = await getToken();
      return send(command, payload, timeout);
    }
  };
  const ensureDaemon = async (): Promise<void> => {
    await withStartLock(paths, options.signal, async () => {
      try {
        token = await getToken();
        await send("ping", {}, 1500);
        return;
      } catch (error) {
        if (options.signal?.aborted) throw error;
        if (errorCode(error) === "SHUTTING_DOWN") {
          const deadline = performance.now() + 5_000;
          while (performance.now() < deadline) {
            try {
              token = await getToken();
              await send("ping", {}, 500);
            } catch (pingError) {
              if (errorCode(pingError) !== "SHUTTING_DOWN" && isDaemonUnavailable(pingError)) break;
            }
            try {
              await sleep(50, options.signal ? { signal: options.signal } : {});
            } catch {
              throw new TuiLensError("ABORTED", "操作已取消");
            }
          }
        }
      }
      await mkdir(paths.home, { recursive: true, mode: 0o700 });
      const log = await open(paths.log, "a", 0o600);
      const child = spawn(
        process.execPath,
        [fileURLToPath(new URL("../interfaces/cli.js", import.meta.url)), "_serve"],
        {
          detached: true,
          windowsHide: true,
          stdio: ["ignore", log.fd, log.fd],
        }
      );
      let launchError: Error | undefined;
      child.on("error", (error) => {
        launchError = error;
      });
      child.unref();
      await log.close();
      let ready = false;
      for (let attempt = 0; attempt < START_ATTEMPTS; attempt += 1) {
        if (options.signal?.aborted) throw new TuiLensError("ABORTED", "操作已取消");
        if (launchError) throw new TuiLensError("DAEMON_START_FAILED", launchError.message);
        try {
          await sleep(START_RETRY_MS, options.signal ? { signal: options.signal } : {});
        } catch {
          throw new TuiLensError("ABORTED", "操作已取消");
        }
        try {
          token = await getToken();
          await send("ping", {}, 1000);
          ready = true;
          break;
        } catch {
          /* 等待新实例建立 IPC。 */
        }
      }
      if (!ready) throw new TuiLensError("DAEMON_START_FAILED", `无法启动本机服务，请查看 ${paths.log}`);
    });
  };
  try {
    return await call(method, params, timeoutMs);
  } catch (error) {
    if (options.signal?.aborted) throw error;
    if (options.autoStart === false) {
      if (isStartableFailure(error)) throw unavailable(error);
      throw error;
    }
    if (!isStartableFailure(error)) throw error;
    await ensureDaemon();
    return await call(method, params, timeoutMs);
  }
}
