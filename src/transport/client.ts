import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, stat, unlink, type FileHandle } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { TuiLensError } from "../core/errors.js";
import type { Method } from "../interfaces/schemas.js";
import { runtimePaths, type RuntimePaths } from "./paths.js";
import {
  DEFAULT_HANDSHAKE_TIMEOUT_MS,
  encodeFrame,
  IPC_VERSION,
  MAX_INFLIGHT_PER_CONNECTION,
  MAX_REQUEST_BYTES,
  MAX_SERVER_FRAME_BYTES,
  serverFrameSchema,
  type IpcEventName,
  type ServerFrame,
} from "./protocol.js";

const START_LOCK_STALE_MS = 30_000;
const START_LOCK_WAIT_MS = 20_000;
const START_LOCK_POLL_MS = 50;
const CLEANUP_LOCK_STALE_MS = 5_000;
const CLEANUP_LOCK_WAIT_MS = 5_000;
const CLEANUP_LOCK_POLL_MS = 25;
const START_ATTEMPTS = 100;
const START_RETRY_MS = 100;
const IDLE_CLOSE_MS = 30_000;

export type IpcEventHandler = (event: IpcEventName, data: unknown) => void;

export interface RequestOptions {
  autoStart?: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
  onEvent?: IpcEventHandler;
  stream?: boolean;
}

function errorCode(error: unknown): string | null {
  if (error instanceof TuiLensError) return error.code;
  return (error as NodeJS.ErrnoException | null)?.code ?? null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function abortError(signal: AbortSignal): TuiLensError {
  return signal.reason instanceof TuiLensError ? signal.reason : new TuiLensError("ABORTED", "操作已取消");
}

function raceAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(abortError(signal));
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      }
    );
  });
}

export async function sleepWithSignal(delayMs: number, signal?: AbortSignal | null): Promise<void> {
  try {
    await sleep(delayMs, null, signal ? { signal } : {});
  } catch (error) {
    if (signal?.aborted) throw new TuiLensError("ABORTED", "操作已取消");
    throw error;
  }
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
    code === "EPIPE" ||
    code === "ENOTSOCK"
  );
}

function isStartableFailure(error: unknown): boolean {
  const code = errorCode(error);
  const sent = error instanceof TuiLensError && isRecord(error.details) && error.details.sent === true;
  return (
    !sent &&
    (code === "DAEMON_UNAVAILABLE" ||
      code === "ENOENT" ||
      code === "ECONNREFUSED" ||
      code === "ENOTSOCK" ||
      code === "SHUTTING_DOWN")
  );
}

interface LockState {
  pid: number;
  token: string;
  at: number;
}

async function readLockState(path: string): Promise<LockState | null> {
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
  return null;
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
  const before = await stat(path).catch(() => null);
  if (!before) return false;
  const state = await readLockState(path);
  if (!state || state.token !== token) return false;
  const after = await stat(path).catch(() => null);
  if (!after || before.dev !== after.dev || before.ino !== after.ino) return false;
  try {
    await unlink(path);
    return true;
  } catch (error) {
    return errorCode(error) === "ENOENT";
  }
}

async function fileIdentity(path: string): Promise<{ dev: number; ino: number } | null> {
  try {
    const info = await lstat(path);
    return { dev: info.dev, ino: info.ino };
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
}

async function handleIdentity(handle: FileHandle): Promise<{ dev: number; ino: number } | null> {
  try {
    const info = await handle.stat();
    return { dev: info.dev, ino: info.ino };
  } catch {
    return null;
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

async function withCleanupLock<T>(path: string, signal: AbortSignal | null, task: () => Promise<T>): Promise<T> {
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
        await sleepWithSignal(10, signal ?? null);
        if (stale) await unlinkIfOwner(path, stale.token);
        else {
          const identity = await fileIdentity(path);
          if (identity && (await lockIsStale(path, CLEANUP_LOCK_STALE_MS))) {
            await unlinkIfIdentity(path, identity).catch(() => null);
          }
        }
        continue;
      }
      if (performance.now() >= deadline) {
        throw new TuiLensError("DAEMON_START_FAILED", `等待本机服务清理锁超时，请查看 ${path}`);
      }
      await sleepWithSignal(CLEANUP_LOCK_POLL_MS, signal ?? null);
      continue;
    }
    const token = randomUUID();
    let wrote = false;
    try {
      await handle.writeFile(JSON.stringify({ pid: process.pid, token, at: Date.now() }), "utf8");
      wrote = true;
      return await task();
    } finally {
      const identity = wrote ? null : await handleIdentity(handle);
      await handle.close().catch(() => null);
      if (wrote) await unlinkIfOwner(path, token).catch(() => null);
      else if (identity) await unlinkIfIdentity(path, identity).catch(() => null);
    }
  }
}

async function removeStaleStartLock(paths: RuntimePaths, signal: AbortSignal | null): Promise<void> {
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
async function withStartLock<T>(paths: RuntimePaths, signal: AbortSignal | null, task: () => Promise<T>): Promise<T> {
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
      await sleepWithSignal(START_LOCK_POLL_MS, signal ?? null);
      continue;
    }
    const token = randomUUID();
    let wrote = false;
    try {
      await handle.writeFile(JSON.stringify({ pid: process.pid, token, at: Date.now() }), "utf8");
      wrote = true;
      return await task();
    } finally {
      const identity = wrote ? null : await handleIdentity(handle);
      await handle.close().catch(() => null);
      if (wrote) await unlinkIfOwner(paths.startLock, token).catch(() => null);
      else if (identity) await unlinkIfIdentity(paths.startLock, identity).catch(() => null);
    }
  }
}

interface PendingRequest {
  id: string;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  controller: AbortController;
  onEvent?: IpcEventHandler;
  timer?: NodeJS.Timeout;
  abortListener?: () => void;
  sent: boolean;
}

interface AuthWaiter {
  resolve(): void;
  reject(error: unknown): void;
  timer: NodeJS.Timeout;
}

export class IpcClient {
  private socket: Socket | null = null;
  private buffer = "";
  private authenticated = false;
  private connecting: Promise<void> | null = null;
  private connectingController: AbortController | null = null;
  private connectionWaiters = 0;
  private authWaiter: AuthWaiter | null = null;
  private readonly inflight = new Map<string, PendingRequest>();
  private idleTimer: NodeJS.Timeout | null = null;

  constructor(private readonly paths: RuntimePaths) {}

  async call(method: Method, params: unknown, options: RequestOptions = {}): Promise<unknown> {
    if (options.signal?.aborted) throw abortError(options.signal);
    const controlled = new AbortController();
    const externalAbort = (): void => controlled.abort(new TuiLensError("ABORTED", "操作已取消"));
    options.signal?.addEventListener("abort", externalAbort, { once: true });
    if (options.signal?.aborted) controlled.abort(new TuiLensError("ABORTED", "操作已取消"));
    const configuredTimeout = Number(process.env.TUILENS_IPC_TIMEOUT_MS);
    const timeoutMs =
      options.timeoutMs ?? (Number.isFinite(configuredTimeout) && configuredTimeout > 0 ? configuredTimeout : 0);
    const timer =
      timeoutMs > 0
        ? setTimeout(() => controlled.abort(new TuiLensError("IPC_TIMEOUT", "本机服务响应超时")), timeoutMs)
        : null;
    try {
      await this.ensureConnected(controlled.signal);
      const socket = this.socket;
      if (!socket || !this.authenticated || socket.destroyed) {
        throw new TuiLensError("DAEMON_UNAVAILABLE", "本机服务连接不可用");
      }
      if (controlled.signal.aborted) throw abortError(controlled.signal);
      if (this.inflight.size >= MAX_INFLIGHT_PER_CONNECTION) {
        throw new TuiLensError("TOO_MANY_INFLIGHT", "单连接在途请求超过 64 个");
      }
      const id = randomUUID();
      let requestFrame: string;
      try {
        requestFrame = encodeFrame({
          type: "req",
          id,
          method,
          params,
          stream: options.stream === true || Boolean(options.onEvent),
        });
      } catch (error) {
        throw new TuiLensError("INVALID_ARGUMENT", "请求参数无法序列化为 NDJSON", {
          reason: error instanceof Error ? error.message : String(error),
        });
      }
      if (Buffer.byteLength(requestFrame) > MAX_REQUEST_BYTES) {
        throw new TuiLensError("REQUEST_LIMIT", "请求超过 1 MiB");
      }
      return await new Promise<unknown>((resolve, reject) => {
        const pending: PendingRequest = {
          id,
          resolve,
          reject,
          controller: controlled,
          ...(options.onEvent ? { onEvent: options.onEvent } : {}),
          ...(timer ? { timer } : {}),
          sent: false,
        };
        const abort = (): void => {
          if (pending.sent && this.socket?.writable) {
            this.socket.write(encodeFrame({ type: "cancel", id }));
          }
          this.completePending(pending, abortError(controlled.signal));
        };
        pending.abortListener = abort;
        this.inflight.set(id, pending);
        this.updateIdleState();
        controlled.signal.addEventListener("abort", abort, { once: true });
        if (controlled.signal.aborted) {
          abort();
          return;
        }
        pending.sent = true;
        socket.write(requestFrame, (error) => {
          if (error)
            this.completePending(
              pending,
              new TuiLensError("IPC_CLOSED", "IPC 请求写入失败", { sent: true, reason: error.message })
            );
        });
      });
    } finally {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", externalAbort);
    }
  }

  async ensureDaemon(signal?: AbortSignal): Promise<void> {
    await withStartLock(this.paths, signal ?? null, async () => {
      try {
        await this.call("ping", {}, { timeoutMs: 1500, ...(signal ? { signal } : {}) });
        return;
      } catch (error) {
        if (signal?.aborted) throw error;
        if (errorCode(error) !== "SHUTTING_DOWN" && !isDaemonUnavailable(error)) throw error;
        if (errorCode(error) === "SHUTTING_DOWN") {
          const deadline = performance.now() + 5_000;
          while (performance.now() < deadline) {
            await sleepWithSignal(50, signal ?? null);
            try {
              await this.call("ping", {}, { timeoutMs: 500, ...(signal ? { signal } : {}) });
              return;
            } catch (pingError) {
              if (errorCode(pingError) !== "SHUTTING_DOWN" && isDaemonUnavailable(pingError)) break;
            }
          }
        }
      }
      await mkdir(this.paths.home, { recursive: true, mode: 0o700 });
      const log = await open(this.paths.log, "a", 0o600);
      const child = spawn(
        process.execPath,
        [fileURLToPath(new URL("../interfaces/cli.js", import.meta.url)), "_serve"],
        {
          detached: true,
          windowsHide: true,
          stdio: ["ignore", log.fd, log.fd],
        }
      );
      let launchError: Error | null = null;
      child.on("error", (error) => {
        launchError = error;
      });
      child.unref();
      await log.close();
      for (let attempt = 0; attempt < START_ATTEMPTS; attempt += 1) {
        if (signal?.aborted) throw new TuiLensError("ABORTED", "操作已取消");
        const failure = launchError as Error | null;
        if (failure) throw new TuiLensError("DAEMON_START_FAILED", failure.message);
        await sleepWithSignal(START_RETRY_MS, signal ?? null);
        try {
          await this.call("ping", {}, { timeoutMs: 1000, ...(signal ? { signal } : {}) });
          return;
        } catch {
          /* 等待新实例建立 IPC。 */
        }
      }
      throw new TuiLensError("DAEMON_START_FAILED", `无法启动本机服务，请查看 ${this.paths.log}`);
    });
  }

  private async ensureConnected(signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw abortError(signal);
    if (this.socket?.writable && this.authenticated) return;
    this.connectionWaiters += 1;
    try {
      if (!this.connecting || this.connectingController?.signal.aborted) {
        const controller = new AbortController();
        const attempt = this.connectWithRetry(controller.signal);
        this.connectingController = controller;
        this.connecting = attempt.finally(() => {
          if (this.connectingController === controller) {
            this.connectingController = null;
            this.connecting = null;
          }
        });
      }
      await raceAbort(this.connecting, signal);
      if (!this.socket?.writable || !this.authenticated) {
        throw new TuiLensError("DAEMON_UNAVAILABLE", "本机服务连接不可用");
      }
    } finally {
      this.connectionWaiters = Math.max(0, this.connectionWaiters - 1);
      if (this.connectionWaiters === 0 && !this.authenticated && this.inflight.size === 0) {
        this.cancelConnectionAttempt();
      }
    }
  }

  private cancelConnectionAttempt(): void {
    this.connectingController?.abort(new TuiLensError("ABORTED", "本机服务连接已取消"));
  }

  private async connectWithRetry(signal: AbortSignal): Promise<void> {
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (signal.aborted) throw abortError(signal);
      try {
        const token = await this.readToken();
        if (signal.aborted) throw abortError(signal);
        await this.connectOnce(token, signal);
        return;
      } catch (error) {
        lastError = error;
        this.resetConnection();
        if (signal.aborted) throw abortError(signal);
        if (attempt === 0 && errorCode(error) === "UNAUTHORIZED") continue;
        throw this.normalizeConnectError(error);
      }
    }
    throw this.normalizeConnectError(lastError);
  }

  private normalizeConnectError(error: unknown): unknown {
    if (error instanceof TuiLensError) {
      if (
        error.code === "ABORTED" ||
        error.code === "UNAUTHORIZED" ||
        error.code === "PROTOCOL_VERSION" ||
        error.code === "IPC_TIMEOUT"
      ) {
        return error;
      }
    }
    if (isDaemonUnavailable(error) || errorCode(error) === "IPC_CLOSED") {
      return new TuiLensError("DAEMON_UNAVAILABLE", "本机服务未运行或无法连接", { reason: errorCode(error) });
    }
    return error;
  }

  private async readToken(): Promise<string> {
    let state: { token?: unknown };
    try {
      state = JSON.parse(await readFile(this.paths.state, "utf8")) as { token?: unknown };
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
        null,
        "The local daemon state file is invalid."
      );
    }
    return state.token;
  }

  private connectOnce(token: string, signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (signal.aborted) {
        reject(abortError(signal));
        return;
      }
      const socket = connect(this.paths.socket);
      this.socket = socket;
      this.buffer = "";
      this.authenticated = false;
      socket.setEncoding("utf8");
      socket.setNoDelay(true);
      let settled = false;
      let waiter: AuthWaiter | null = null;
      const cleanup = (): void => {
        if (!waiter) return;
        clearTimeout(waiter.timer);
        if (this.authWaiter === waiter) this.authWaiter = null;
        signal.removeEventListener("abort", aborted);
      };
      const succeed = (): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      };
      const fail = (error: unknown): void => {
        if (settled) return;
        settled = true;
        cleanup();
        if (this.socket === socket) {
          this.socket = null;
          this.authenticated = false;
          this.buffer = "";
        }
        if (!socket.destroyed) socket.destroy();
        reject(error);
      };
      const aborted = (): void => fail(abortError(signal));
      const timer = setTimeout(() => fail(new TuiLensError("IPC_TIMEOUT", "IPC 握手超时")), this.handshakeTimeout());
      waiter = { resolve: succeed, reject: fail, timer };
      this.authWaiter = waiter;
      signal.addEventListener("abort", aborted, { once: true });
      socket.once("connect", () => {
        if (signal.aborted) {
          fail(abortError(signal));
          return;
        }
        socket.write(encodeFrame({ type: "auth", version: IPC_VERSION, token }));
      });
      socket.on("data", (chunk: string) => this.handleData(socket, chunk));
      socket.on("error", () => {
        /* close 事件统一清理鉴权和在途请求。 */
      });
      socket.once("close", () => this.handleClose(socket));
    });
  }

  private handshakeTimeout(): number {
    const configured = Number(process.env.TUILENS_IPC_HANDSHAKE_TIMEOUT_MS);
    return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_HANDSHAKE_TIMEOUT_MS;
  }

  private handleData(socket: Socket, chunk: string): void {
    if (this.socket !== socket) return;
    this.buffer += chunk;
    while (true) {
      const end = this.buffer.indexOf("\n");
      if (end < 0) {
        if (Buffer.byteLength(this.buffer) > MAX_SERVER_FRAME_BYTES) {
          this.failConnection(new TuiLensError("RESPONSE_LIMIT", "响应超过大小限制"));
        }
        return;
      }
      const line = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 1);
      if (line.length === 0) continue;
      if (Buffer.byteLength(line) > MAX_SERVER_FRAME_BYTES) {
        this.failConnection(new TuiLensError("RESPONSE_LIMIT", "响应超过大小限制"));
        return;
      }
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        this.failConnection(new TuiLensError("PROTOCOL_ERROR", "服务端返回了非法 JSON"));
        return;
      }
      const parsed = serverFrameSchema.safeParse(value);
      if (!parsed.success) {
        this.failConnection(new TuiLensError("PROTOCOL_ERROR", "服务端返回了非法帧", parsed.error.issues));
        return;
      }
      this.handleFrame(parsed.data);
      if (!this.socket) return;
    }
  }

  private handleFrame(frame: ServerFrame): void {
    if (frame.type === "auth_ok") {
      if (!this.authWaiter) {
        this.failConnection(new TuiLensError("PROTOCOL_ERROR", "未请求的鉴权响应"));
        return;
      }
      this.authenticated = true;
      this.authWaiter.resolve();
      this.updateIdleState();
      return;
    }
    if (frame.type === "auth_error") {
      const error = new TuiLensError(
        frame.error.code,
        frame.error.messageZh || frame.error.message,
        frame.error.details,
        frame.error.messageEn || frame.error.message
      );
      if (this.authWaiter) this.authWaiter.reject(error);
      else this.failConnection(error);
      return;
    }
    if (!this.authenticated) {
      this.failConnection(new TuiLensError("PROTOCOL_ERROR", "鉴权前收到普通响应"));
      return;
    }
    if (frame.type === "event") {
      const pending = this.inflight.get(frame.id);
      if (!pending?.onEvent) return;
      try {
        pending.onEvent(frame.event, frame.data);
      } catch (error) {
        this.cancelPending(pending, new TuiLensError("INTERNAL", "IPC 事件处理失败", { reason: String(error) }));
      }
      return;
    }
    const pending = this.inflight.get(frame.id);
    if (!pending) return;
    if (frame.ok) {
      this.completePending(pending, null, frame.data);
    } else {
      const error = frame.error;
      this.completePending(
        pending,
        new TuiLensError(
          error?.code ?? "REMOTE_ERROR",
          error?.messageZh || error?.message || "操作失败",
          error?.details,
          error?.messageEn || error?.message || "The operation failed."
        )
      );
    }
  }

  private handleClose(socket: Socket): void {
    if (this.socket !== socket) return;
    this.socket = null;
    this.authenticated = false;
    this.buffer = "";
    const auth = this.authWaiter;
    this.authWaiter = null;
    if (auth) {
      clearTimeout(auth.timer);
      auth.reject(new TuiLensError("IPC_CLOSED", "本机服务连接已关闭"));
    }
    for (const pending of [...this.inflight.values()]) {
      this.completePending(pending, new TuiLensError("IPC_CLOSED", "本机服务连接已关闭", { sent: pending.sent }));
    }
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private failConnection(error: unknown): void {
    const socket = this.socket;
    this.socket = null;
    this.authenticated = false;
    this.buffer = "";
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    this.authWaiter?.reject(error);
    for (const pending of [...this.inflight.values()]) {
      this.completePending(pending, error);
    }
    if (socket && !socket.destroyed) socket.destroy();
  }

  private cancelPending(pending: PendingRequest, error: unknown): void {
    if (this.socket?.writable) {
      this.socket.write(encodeFrame({ type: "cancel", id: pending.id }));
    }
    this.completePending(pending, error);
  }

  private completePending(pending: PendingRequest, error: unknown = null, data: unknown = null): void {
    if (this.inflight.get(pending.id) !== pending) return;
    if (pending.timer) clearTimeout(pending.timer);
    if (pending.abortListener) pending.controller.signal.removeEventListener("abort", pending.abortListener);
    this.inflight.delete(pending.id);
    this.updateIdleState();
    if (error !== null) pending.reject(error);
    else pending.resolve(data);
  }

  private updateIdleState(): void {
    const socket = this.socket;
    if (!socket || socket.destroyed || !this.authenticated) return;
    if (this.inflight.size > 0) {
      socket.ref();
      if (this.idleTimer) {
        clearTimeout(this.idleTimer);
        this.idleTimer = null;
      }
      return;
    }
    socket.unref();
    if (this.idleTimer) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.inflight.size === 0) this.resetConnection();
    }, IDLE_CLOSE_MS);
    this.idleTimer.unref();
  }

  private resetConnection(): void {
    const socket = this.socket;
    this.socket = null;
    this.authenticated = false;
    this.buffer = "";
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (socket && !socket.destroyed) socket.destroy();
  }
}

const clients = new Map<string, IpcClient>();

function clientFor(paths: RuntimePaths): IpcClient {
  let client = clients.get(paths.socket);
  if (!client) {
    client = new IpcClient(paths);
    clients.set(paths.socket, client);
  }
  return client;
}

export async function request(method: Method, params: unknown = {}, options: RequestOptions = {}): Promise<unknown> {
  const client = clientFor(runtimePaths());
  try {
    return await client.call(method, params, options);
  } catch (error) {
    if (options.signal?.aborted) throw error;
    if (options.autoStart === false) {
      if (isDaemonUnavailable(error) || errorCode(error) === "SHUTTING_DOWN") {
        throw new TuiLensError(
          "DAEMON_UNAVAILABLE",
          "本机服务未运行或无法连接",
          { reason: errorCode(error) },
          "The local daemon is not running or cannot be reached."
        );
      }
      throw error;
    }
    if (!isStartableFailure(error)) throw error;
    await client.ensureDaemon(options.signal);
    return client.call(method, params, options);
  }
}
