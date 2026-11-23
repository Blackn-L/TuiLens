import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, lstat, mkdir, unlink, writeFile } from "node:fs/promises";
import { connect, createServer, type Socket } from "node:net";
import { z } from "zod";
import { errorRecord, TuiLensError } from "../core/errors.js";
import { SessionManager } from "../session/manager.js";
import { dispatch } from "./dispatcher.js";
import { runtimePaths } from "./paths.js";

const requestSchema = z.object({ token: z.string(), method: z.string(), params: z.unknown() }).strict();
const MAX_REQUEST = 1024 * 1024;

function tokenMatches(actual: string, expected: string): boolean {
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function errnoCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
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
      // 端点有响应但暂未接受连接时不能删除，否则会破坏仍在运行的服务。
      probe.destroy();
      resolve("unknown");
    });
  });
}

async function socketIdentity(socketPath: string): Promise<string | undefined> {
  try {
    const info = await lstat(socketPath);
    return `${info.dev}:${info.ino}:${info.mtimeMs}:${info.size}`;
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return undefined;
    throw error;
  }
}

/** 仅在探测到同一路径仍是拒绝连接的旧文件时移除，避免误删刚重建的端点。 */
async function clearStaleUnixSocket(socketPath: string): Promise<boolean> {
  const before = await socketIdentity(socketPath);
  if (before === undefined) return true;
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

export async function serve(): Promise<void> {
  const paths = runtimePaths();
  await mkdir(paths.home, { recursive: true, mode: 0o700 });
  const token = randomBytes(32).toString("hex");
  const ipcTimeout = Number(process.env.TUILENS_IPC_TIMEOUT_MS);
  const configuredLimit = Number(process.env.TUILENS_MAX_SESSIONS);
  const manager = new SessionManager({
    artifactDir: paths.artifactDir,
    ...(process.env.TUILENS_BROWSER_PATH ? { executablePath: process.env.TUILENS_BROWSER_PATH } : {}),
    ...(process.env.TUILENS_FONT_FAMILY ? { fontFamily: process.env.TUILENS_FONT_FAMILY } : {}),
    ...(process.env.TUILENS_FONT_FILE ? { fontFile: process.env.TUILENS_FONT_FILE } : {}),
    ...(process.env.TUILENS_PTY_WORKER === "1" ? { ptyWorker: true } : {}),
    // 守护进程共享同一浏览器宿主，矩阵测试可按需提高并发会话上限。
    ...(Number.isInteger(configuredLimit) && configuredLimit > 0 ? { maxSessions: configuredLimit } : {}),
  });
  let stopping = false;
  const connections = new Set<Socket>();
  const server = createServer((socket) => {
    connections.add(socket);
    const abort = new AbortController();
    let buffer = Buffer.alloc(0);
    let received = false;
    socket.on("error", () => abort.abort());
    socket.on("close", () => {
      abort.abort();
      connections.delete(socket);
    });
    if (Number.isFinite(ipcTimeout) && ipcTimeout > 0) socket.setTimeout(ipcTimeout, () => socket.destroy());
    socket.on("data", (data: Buffer) => {
      if (received) return;
      buffer = Buffer.concat([buffer, data]);
      if (buffer.length > MAX_REQUEST) {
        socket.destroy();
        return;
      }
      const end = buffer.indexOf(10);
      if (end < 0) return;
      received = true;
      void (async () => {
        let shutdownRequested = false;
        try {
          if (stopping) throw new TuiLensError("SHUTTING_DOWN", "服务正在关闭");
          const request = requestSchema.parse(JSON.parse(buffer.subarray(0, end).toString("utf8")));
          if (!tokenMatches(request.token, token)) throw new TuiLensError("UNAUTHORIZED", "本机连接认证失败");
          shutdownRequested = request.method === "shutdown";
          const value = await dispatch(manager, request.method, request.params, abort.signal);
          socket.end(JSON.stringify({ ok: true, data: value }) + "\n");
        } catch (error) {
          if (!socket.destroyed) socket.end(JSON.stringify({ ok: false, error: errorRecord(error) }) + "\n");
        } finally {
          // 即使会话释放失败，仍需停止已进入 disposed 状态的守护进程入口。
          if (shutdownRequested)
            setImmediate(() => {
              void stop().catch(reportStopError);
            });
        }
      })();
    });
  });
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
    // 状态无法发布时不能留下无法认证但仍占用端点的半启动服务。
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
    // 取消仍在等待的客户端，防止 shutdown 被长等待连接拖住。
    for (const socket of connections) {
      if (!socket.writableEnded) socket.destroy();
    }
    let failure: unknown;
    try {
      await manager.closeAll();
    } catch (error) {
      failure = error;
    }
    // 保留失效状态供下次启动覆盖，避免停止与重启交错时误删新实例凭据。
    // 文件存在从不代表服务仍在运行，客户端每次实际请求都会验证端点。
    await closed;
    if (failure) throw failure;
  }
  const shutdownSignals: NodeJS.Signals[] =
    process.platform === "win32" ? ["SIGINT", "SIGTERM", "SIGBREAK"] : ["SIGINT", "SIGTERM", "SIGHUP"];
  for (const name of shutdownSignals) {
    process.once(name, () => {
      void stop().catch(reportStopError);
    });
  }
}
