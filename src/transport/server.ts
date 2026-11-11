import { randomBytes } from "node:crypto";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { z } from "zod";
import { errorRecord, TuiLensError } from "../core/errors.js";
import { SessionManager } from "../session/manager.js";
import { dispatch } from "./dispatcher.js";
import { runtimePaths } from "./paths.js";

const requestSchema = z.object({ token: z.string(), method: z.string(), params: z.unknown() }).strict();
const MAX_REQUEST = 1024 * 1024;

export async function serve(): Promise<void> {
  const paths = runtimePaths();
  await mkdir(paths.home, { recursive: true, mode: 0o700 });
  const token = randomBytes(32).toString("hex");
  const configuredLimit = Number(process.env.TUILENS_MAX_SESSIONS);
  const manager = new SessionManager({
    artifactDir: paths.artifactDir,
    ...(process.env.TUILENS_BROWSER_PATH ? { executablePath: process.env.TUILENS_BROWSER_PATH } : {}),
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
    socket.on("close", () => { abort.abort(); connections.delete(socket); });
    socket.setTimeout(330000, () => socket.destroy());
    socket.on("data", (data: Buffer) => {
      if (received) return;
      buffer = Buffer.concat([buffer, data]);
      if (buffer.length > MAX_REQUEST) { socket.destroy(); return; }
      const end = buffer.indexOf(10);
      if (end < 0) return;
      received = true;
      void (async () => {
        let shutdownRequested = false;
        try {
          if (stopping) throw new TuiLensError("SHUTTING_DOWN", "服务正在关闭");
          const request = requestSchema.parse(JSON.parse(buffer.subarray(0, end).toString("utf8")));
          if (request.token !== token) throw new TuiLensError("UNAUTHORIZED", "本机连接认证失败");
          shutdownRequested = request.method === "shutdown";
          const value = await dispatch(manager, request.method, request.params, abort.signal);
          socket.end(JSON.stringify({ ok: true, data: value }) + "\n");
        } catch (error) {
          if (!socket.destroyed) socket.end(JSON.stringify({ ok: false, error: errorRecord(error) }) + "\n");
        } finally {
          // 即使会话释放失败，仍需停止已进入 disposed 状态的守护进程入口。
          if (shutdownRequested) setImmediate(() => { void stop().catch(reportStopError); });
        }
      })();
    });
  });
  server.on("error", (error) => { process.stderr.write(`${errorRecord(error).message}\n`); });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(paths.socket, () => { server.off("error", reject); resolve(); });
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
    try { await manager.closeAll(); } catch (error) { failure = error; }
    // 保留失效状态供下次启动覆盖，避免停止与重启交错时误删新实例凭据。
    // 客户端总会 ping 活端点，文件存在从不代表服务仍在运行。
    await closed;
    if (failure) throw failure;
  }
  for (const name of ["SIGINT", "SIGTERM"] as const) {
    process.once(name, () => { void stop().catch(reportStopError); });
  }
}
