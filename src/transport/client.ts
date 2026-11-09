import { spawn } from "node:child_process";
import { mkdir, open, readFile } from "node:fs/promises";
import { connect } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { TuiLensError } from "../core/errors.js";
import type { Method } from "../interfaces/schemas.js";
import { runtimePaths } from "./paths.js";

export async function request(method: Method, params: unknown = {}, options: { autoStart?: boolean; signal?: AbortSignal; timeoutMs?: number } = {}): Promise<unknown> {
  const paths = runtimePaths();
  let token = "";
  const getToken = async (): Promise<string> => {
    const state = JSON.parse(await readFile(paths.state, "utf8")) as { token?: unknown };
    if (typeof state.token !== "string") throw new Error("Invalid daemon state");
    return state.token;
  };
  const send = (command: string, payload: unknown, timeoutMs: number): Promise<unknown> => new Promise((resolve, reject) => {
    if (options.signal?.aborted) { reject(new TuiLensError("ABORTED", "操作已取消")); return; }
    const socket = connect(paths.socket);
    let text = "";
    let bytes = 0;
    const abort = () => socket.destroy(new TuiLensError("ABORTED", "操作已取消"));
    options.signal?.addEventListener("abort", abort, { once: true });
    const cleanup = () => options.signal?.removeEventListener("abort", abort);
    socket.setEncoding("utf8");
    socket.setTimeout(timeoutMs, () => socket.destroy(new TuiLensError("IPC_TIMEOUT", "本机服务响应超时")));
    socket.once("connect", () => socket.write(JSON.stringify({ token, method: command, params: payload }) + "\n"));
    socket.on("data", (part: string) => {
      text += part;
      bytes += Buffer.byteLength(part);
      if (bytes > 64 * 1024 * 1024) { socket.destroy(new TuiLensError("RESPONSE_LIMIT", "响应超过大小限制")); return; }
      const end = text.indexOf("\n");
      if (end < 0) return;
      try {
        const response = JSON.parse(text.slice(0, end)) as { ok: boolean; data?: unknown; error?: { code: string; message: string; details?: unknown } };
        if (!response.ok) reject(new TuiLensError(response.error?.code ?? "REMOTE_ERROR", response.error?.message ?? "操作失败", response.error?.details));
        else resolve(response.data);
      } catch (error) { reject(error); }
      socket.destroy();
    });
    socket.once("error", reject);
    socket.once("close", () => { cleanup(); reject(new TuiLensError("IPC_CLOSED", "本机服务连接已关闭")); });
  });
  try {
    token = await getToken();
    await send("ping", {}, 1500);
  } catch (error) {
    if (options.autoStart === false || options.signal?.aborted) throw error;
    await mkdir(paths.home, { recursive: true, mode: 0o700 });
    const log = await open(paths.log, "a", 0o600);
    const child = spawn(process.execPath, [fileURLToPath(new URL("../interfaces/cli.js", import.meta.url)), "_serve"], {
      detached: true, windowsHide: true, stdio: ["ignore", log.fd, log.fd],
    });
    let launchError: Error | undefined;
    child.on("error", (error) => { launchError = error; });
    child.unref();
    await log.close();
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (options.signal?.aborted) throw new TuiLensError("ABORTED", "操作已取消");
      if (launchError) throw new TuiLensError("DAEMON_START_FAILED", launchError.message);
      await sleep(100);
      try { token = await getToken(); await send("ping", {}, 1000); ready = true; break; } catch { /* 等待新实例建立 IPC。 */ }
    }
    if (!ready) throw new TuiLensError("DAEMON_START_FAILED", `无法启动本机服务，请查看 ${paths.log}`);
  }
  return send(method, params, options.timeoutMs ?? 320000);
}
