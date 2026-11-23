import * as nodePty from "node-pty";
import type { IPty } from "node-pty";
import { installWindowsConptyCleanup, releaseWindowsConptyWorker } from "./pty-runtime.js";
import type { PtyWorkerEvent, PtyWorkerRequest } from "./pty-worker-protocol.js";

let pty: IPty | undefined;
let exited = false;

function send(event: PtyWorkerEvent): void {
  try {
    process.send?.(event);
  } catch {
    /* 父进程已断开；按退出路径清理。 */
  }
}

function fail(error: unknown): void {
  send({ type: "error", message: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
  setImmediate(() => process.exit(1));
}

process.on("message", (message: PtyWorkerRequest) => {
  try {
    if (!pty) {
      if (message.type !== "spawn") throw new Error("PTY worker received a command before spawn");
      pty = nodePty.spawn(message.options.command, message.options.args, {
        name: message.options.name,
        cols: message.options.cols,
        rows: message.options.rows,
        cwd: message.options.cwd,
        env: message.options.env,
        ...(message.options.useConptyDll ? { useConptyDll: true } : {}),
      });
      installWindowsConptyCleanup(pty);
      send({ type: "ready", pid: pty.pid, cols: pty.cols, rows: pty.rows });
      pty.onData((data) => send({ type: "data", data }));
      pty.onExit(({ exitCode, signal }) => {
        if (exited) return;
        exited = true;
        send({ type: "exit", exitCode, ...(signal === undefined ? {} : { signal }) });
        releaseWindowsConptyWorker(pty!);
        // 给 IPC 发送一次刷新机会，再结束 worker。
        setTimeout(() => process.exit(0), 20).unref();
      });
      return;
    }
    switch (message.type) {
      case "write":
        pty.write(message.data);
        break;
      case "resize":
        pty.resize(message.cols, message.rows);
        break;
      case "pause":
        pty.pause();
        break;
      case "resume":
        pty.resume();
        break;
      case "kill":
        pty.kill(message.signal);
        break;
      case "spawn":
        throw new Error("PTY worker already spawned");
    }
  } catch (error) {
    fail(error);
  }
});

process.on("disconnect", () => {
  try {
    if (!exited) pty?.kill();
  } catch {
    /* 尽力清理。 */
  }
  process.exit(0);
});

process.on("uncaughtException", fail);
process.on("unhandledRejection", fail);
