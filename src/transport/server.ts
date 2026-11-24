import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, lstat, mkdir, unlink, writeFile } from "node:fs/promises";
import { connect, createServer, type Socket } from "node:net";
import { errorRecord, TuiLensError, type ErrorRecord } from "../core/errors.js";
import { SessionManager } from "../session/manager.js";
import { VERSION } from "../version.js";
import { dispatch, type DispatchEmit } from "./dispatcher.js";
import { runtimePaths } from "./paths.js";
import {
  authFrameSchema,
  clientFrameSchema,
  DEFAULT_HANDSHAKE_TIMEOUT_MS,
  encodeFrame,
  IPC_VERSION,
  MAX_INFLIGHT_PER_CONNECTION,
  MAX_REQUEST_BYTES,
  type AuthErrorFrame,
  type ServerFrame,
} from "./protocol.js";

const MAX_EVENT_BACKLOG_BYTES = 8 * 1024 * 1024;
const SHUTDOWN_FLUSH_TIMEOUT_MS = 1000;

function tokenMatches(actual: string, expected: string): boolean {
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function errnoCode(error: unknown): string | null {
  return (error as NodeJS.ErrnoException | null)?.code ?? null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Flush the shutdown response before stopping; the timer bounds a broken peer. */
export function writeFrameBeforeStop(
  socket: Pick<Socket, "writable" | "destroyed" | "write">,
  frame: ServerFrame,
  stop: () => void,
  timeoutMs = SHUTDOWN_FLUSH_TIMEOUT_MS
): void {
  let completed = false;
  let timer: NodeJS.Timeout;
  const complete = (): void => {
    if (completed) return;
    completed = true;
    clearTimeout(timer);
    stop();
  };
  timer = setTimeout(complete, Math.max(1, timeoutMs));
  timer.unref();
  if (socket.destroyed || !socket.writable) {
    complete();
    return;
  }
  try {
    socket.write(encodeFrame(frame), () => complete());
  } catch {
    complete();
  }
}

type SocketProbe = "live" | "stale" | "missing" | "unknown";

/** Unix 域套接字的路径不会随进程被杀而回收。 */
async function probeUnixSocket(socketPath: string): Promise<SocketProbe> {
  return new Promise<SocketProbe>((resolve) => {
    const probe = connect(socketPath);
    probe.once("connect", () => {
      probe.destroy();
      resolve("live");
    });
    probe.once("error", (error) => {
      const code = errnoCode(error);
      probe.destroy();
      resolve(code === "ECONNREFUSED" ? "stale" : code === "ENOENT" ? "missing" : "unknown");
    });
    probe.setTimeout(1000, () => {
      probe.destroy();
      resolve("unknown");
    });
  });
}

async function socketIdentity(socketPath: string): Promise<string | null> {
  try {
    const info = await lstat(socketPath);
    return `${info.dev}:${info.ino}:${info.mtimeMs}:${info.size}`;
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return null;
    throw error;
  }
}

/** 仅在探测到同一路径仍是拒绝连接的旧文件时移除，避免误删刚重建的端点。 */
async function clearStaleUnixSocket(socketPath: string): Promise<boolean> {
  const before = await socketIdentity(socketPath);
  if (before === null) return true;
  const probe = await probeUnixSocket(socketPath);
  if (probe === "missing") return true;
  if (probe !== "stale") return false;
  if ((await socketIdentity(socketPath)) !== before) return true;
  try {
    await unlink(socketPath);
    return true;
  } catch (error) {
    if (errnoCode(error) !== "ENOENT") throw error;
    return true;
  }
}

interface ConnectionState {
  socket: Socket;
  destroy(): void;
}

export async function serve(): Promise<void> {
  const paths = runtimePaths();
  await mkdir(paths.home, { recursive: true, mode: 0o700 });
  const token = randomBytes(32).toString("hex");
  const configuredIpcTimeout = Number(process.env.TUILENS_IPC_TIMEOUT_MS);
  const configuredHandshakeTimeout = Number(process.env.TUILENS_IPC_HANDSHAKE_TIMEOUT_MS);
  const handshakeTimeout =
    Number.isFinite(configuredHandshakeTimeout) && configuredHandshakeTimeout > 0
      ? configuredHandshakeTimeout
      : DEFAULT_HANDSHAKE_TIMEOUT_MS;
  const configuredLimit = Number(process.env.TUILENS_MAX_SESSIONS);
  const manager = new SessionManager({
    artifactDir: paths.artifactDir,
    ...(process.env.TUILENS_BROWSER_PATH ? { executablePath: process.env.TUILENS_BROWSER_PATH } : {}),
    ...(process.env.TUILENS_FONT_FAMILY ? { fontFamily: process.env.TUILENS_FONT_FAMILY } : {}),
    ...(process.env.TUILENS_FONT_FILE ? { fontFile: process.env.TUILENS_FONT_FILE } : {}),
    ...(process.env.TUILENS_PTY_WORKER === "1" ? { ptyWorker: true } : {}),
    ...(Number.isInteger(configuredLimit) && configuredLimit > 0 ? { maxSessions: configuredLimit } : {}),
  });
  let stopping = false;
  const connections = new Set<ConnectionState>();

  function sendFrame(state: ConnectionState, frame: ServerFrame, dropOnBackpressure = false): boolean {
    const { socket } = state;
    if (socket.destroyed || !socket.writable) return false;
    if (dropOnBackpressure && socket.writableLength > MAX_EVENT_BACKLOG_BYTES) return false;
    socket.write(encodeFrame(frame));
    return true;
  }

  function sendProtocolError(
    state: ConnectionState,
    id: string | null,
    error: unknown,
    inflight: Map<string, AbortController>
  ): void {
    if (id && inflight.has(id)) {
      state.destroy();
    } else if (id) {
      sendFrame(state, { type: "res", id, ok: false, error: errorRecord(error) });
    } else {
      state.destroy();
    }
  }

  function openConnection(socket: Socket): void {
    socket.setEncoding("utf8");
    let authenticated = false;
    let inputOpen = true;
    let buffer = "";
    const inflight = new Map<string, AbortController>();
    const handshakeTimer = setTimeout(() => {
      inputOpen = false;
      socket.destroy();
    }, handshakeTimeout);

    const state: ConnectionState = {
      socket,
      destroy: () => {
        inputOpen = false;
        for (const controller of inflight.values()) controller.abort();
        inflight.clear();
        if (!socket.destroyed) socket.destroy();
      },
    };
    connections.add(state);
    socket.on("error", () => {
      inputOpen = false;
    });
    socket.on("close", () => {
      clearTimeout(handshakeTimer);
      inputOpen = false;
      for (const controller of inflight.values()) controller.abort();
      inflight.clear();
      connections.delete(state);
    });

    function rejectAuth(error: unknown): void {
      inputOpen = false;
      clearTimeout(handshakeTimer);
      const frame: AuthErrorFrame = { type: "auth_error", error: errorRecord(error) };
      if (!socket.destroyed && socket.writable) socket.end(encodeFrame(frame));
    }

    function protocolClose(): void {
      inputOpen = false;
      state.destroy();
    }

    function processLine(line: string): void {
      if (!inputOpen) return;
      if (Buffer.byteLength(line) > MAX_REQUEST_BYTES) {
        protocolClose();
        return;
      }
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        protocolClose();
        return;
      }

      if (!authenticated) {
        if (!isRecord(value) || value.type !== "auth") {
          rejectAuth(new TuiLensError("AUTH_REQUIRED", "IPC 首帧必须完成 v2 鉴权"));
          return;
        }
        if (value.version !== IPC_VERSION) {
          rejectAuth(new TuiLensError("PROTOCOL_VERSION", `仅支持 IPC v${IPC_VERSION}`));
          return;
        }
        const parsed = authFrameSchema.safeParse(value);
        if (!parsed.success) {
          rejectAuth(new TuiLensError("PROTOCOL_ERROR", "IPC 鉴权帧不合法"));
          return;
        }
        if (!tokenMatches(parsed.data.token, token)) {
          rejectAuth(new TuiLensError("UNAUTHORIZED", "本机连接认证失败"));
          return;
        }
        authenticated = true;
        clearTimeout(handshakeTimer);
        if (Number.isFinite(configuredIpcTimeout) && configuredIpcTimeout > 0) {
          socket.setTimeout(configuredIpcTimeout, () => socket.destroy());
        }
        sendFrame(state, {
          type: "auth_ok",
          version: IPC_VERSION,
          daemonPid: process.pid,
          daemonVersion: VERSION,
        });
        return;
      }

      if (isRecord(value) && value.type === "auth") {
        protocolClose();
        return;
      }
      const parsed = clientFrameSchema.safeParse(value);
      if (!parsed.success) {
        const id = isRecord(value) && typeof value.id === "string" ? value.id : null;
        sendProtocolError(state, id, new TuiLensError("PROTOCOL_ERROR", "IPC 帧不合法", parsed.error.issues), inflight);
        return;
      }
      if (parsed.data.type === "cancel") {
        inflight.get(parsed.data.id)?.abort();
        return;
      }
      if (parsed.data.type !== "req") {
        protocolClose();
        return;
      }

      const request = parsed.data;
      if (inflight.has(request.id)) {
        protocolClose();
        return;
      }
      if (inflight.size >= MAX_INFLIGHT_PER_CONNECTION) {
        sendFrame(state, {
          type: "res",
          id: request.id,
          ok: false,
          error: errorRecord(new TuiLensError("TOO_MANY_INFLIGHT", "单连接在途请求超过 64 个")),
        });
        return;
      }
      const controller = new AbortController();
      inflight.set(request.id, controller);
      const emit: DispatchEmit = (event, data) => {
        if (!request.stream || socket.destroyed) return;
        sendFrame(state, { type: "event", id: request.id, event, data }, true);
      };
      void (async () => {
        let shutdownRequested = false;
        let response: ServerFrame;
        try {
          if (stopping) throw new TuiLensError("SHUTTING_DOWN", "服务正在关闭");
          shutdownRequested = request.method === "shutdown";
          const data = await dispatch(manager, request.method, request.params, controller.signal, emit);
          response = { type: "res", id: request.id, ok: true, data };
        } catch (error) {
          response = {
            type: "res",
            id: request.id,
            ok: false,
            error: errorRecord(error),
          };
        } finally {
          inflight.delete(request.id);
        }
        if (shutdownRequested) {
          writeFrameBeforeStop(
            socket,
            response,
            () => {
              void stop().catch(reportStopError);
            },
            SHUTDOWN_FLUSH_TIMEOUT_MS
          );
        } else {
          sendFrame(state, response);
        }
      })();
    }

    socket.on("data", (part: string) => {
      if (!inputOpen) return;
      buffer += part;
      while (inputOpen) {
        const end = buffer.indexOf("\n");
        if (end < 0) {
          if (Buffer.byteLength(buffer) > MAX_REQUEST_BYTES) {
            protocolClose();
          }
          return;
        }
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (line.length === 0) continue;
        processLine(line);
      }
    });
  }

  const server = createServer(openConnection);
  const listenOnce = (): Promise<void> =>
    new Promise((resolve, reject) => {
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
      server.listen(paths.socket);
    });
  for (let attempt = 0; ; attempt += 1) {
    try {
      await listenOnce();
      break;
    } catch (error) {
      const recover =
        process.platform !== "win32" &&
        process.platform !== "linux" &&
        errnoCode(error) === "EADDRINUSE" &&
        attempt < 2 &&
        (await clearStaleUnixSocket(paths.socket));
      if (!recover) throw error;
    }
  }
  server.on("error", (error) => {
    process.stderr.write(`${errorRecord(error).message}\n`);
  });
  try {
    if (process.platform !== "win32" && process.platform !== "linux") await chmod(paths.socket, 0o600);
    await writeFile(paths.state, JSON.stringify({ token, pid: process.pid }), { mode: 0o600 });
  } catch (error) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await manager.closeAll();
    throw error;
  }
  function reportStopError(error: unknown): void {
    process.stderr.write(errorRecord(error).message + "\n");
    process.exitCode = 1;
  }
  async function stop(): Promise<void> {
    if (stopping) return;
    stopping = true;
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    for (const state of connections) state.destroy();
    let failure: unknown = null;
    try {
      await manager.closeAll();
    } catch (error) {
      failure = error;
    }
    await closed;
    if (failure !== null) throw failure;
  }
  const shutdownSignals: NodeJS.Signals[] =
    process.platform === "win32" ? ["SIGINT", "SIGTERM", "SIGBREAK"] : ["SIGINT", "SIGTERM", "SIGHUP"];
  for (const name of shutdownSignals) {
    process.once(name, () => {
      void stop().catch(reportStopError);
    });
  }
}
