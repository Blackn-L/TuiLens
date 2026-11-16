import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { IDisposable } from "node-pty";
import { TuiLensError } from "../core/errors.js";
import type { PtyHandle } from "./pty-runtime.js";
import type { PtySpawnOptions, PtyWorkerEvent, PtyWorkerRequest } from "./pty-worker-protocol.js";

const WORKER_SCRIPT = fileURLToPath(new URL("./pty-worker.js", import.meta.url));

interface ExitEvent {
  exitCode: number;
  signal?: number;
}

/**
 * 可选 PTY worker：原生模块在子进程中加载，父 daemon 只处理 IPC。
 * 数据先缓存在客户端，保证 ready 返回前到达的字节不会丢失。
 */
export function spawnIsolatedPty(options: PtySpawnOptions, signal?: AbortSignal): Promise<PtyHandle> {
  return new Promise<PtyHandle>((resolve, reject) => {
    const child: ChildProcess = fork(WORKER_SCRIPT, [], {
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      windowsHide: true,
    });
    const dataListeners = new Set<(data: string) => void>();
    const exitListeners = new Set<(event: ExitEvent) => void>();
    const pendingData: string[] = [];
    let exitEvent: ExitEvent | undefined;
    let ready = false;
    let resolved = false;
    let exited = false;
    let cols = options.cols;
    let rows = options.rows;
    let pid = 0;
    let timer: NodeJS.Timeout | undefined;
    let abort: (() => void) | undefined;

    const clearReadiness = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      if (abort) signal?.removeEventListener("abort", abort);
      abort = undefined;
    };
    const terminate = (): void => {
      try {
        if (child.connected) child.send({ type: "kill" } satisfies PtyWorkerRequest);
      } catch { /* 连接可能已经关闭。 */ }
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          try { child.kill(); } catch { /* 已退出。 */ }
        }
      }, 750).unref();
    };
    const fail = (error: unknown): void => {
      clearReadiness();
      if (!resolved) {
        resolved = true;
        terminate();
        reject(error instanceof TuiLensError ? error
          : new TuiLensError("PROCESS_START_FAILED", "无法启动隔离的 PTY worker", {
            reason: error instanceof Error ? error.message : String(error),
          }));
        return;
      }
      terminate();
      if (!exited) {
        exited = true;
        exitEvent = { exitCode: 1 };
        for (const listener of exitListeners) listener(exitEvent);
      }
    };
    const emitData = (data: string): void => {
      if (dataListeners.size === 0) pendingData.push(data);
      else for (const listener of dataListeners) listener(data);
    };
    const emitExit = (event: ExitEvent): void => {
      if (exited) return;
      exited = true;
      exitEvent = event;
      for (const listener of exitListeners) listener(event);
    };
    const handleMessage = (event: PtyWorkerEvent): void => {
      switch (event.type) {
        case "ready":
          if (ready || resolved) return;
          ready = true;
          pid = event.pid;
          cols = event.cols;
          rows = event.rows;
          clearReadiness();
          const handle: PtyHandle = {
            get pid() { return pid; },
            get cols() { return cols; },
            get rows() { return rows; },
            onData(listener) {
              dataListeners.add(listener);
              if (pendingData.length) {
                const buffered = pendingData.splice(0);
                for (const data of buffered) listener(data);
              }
              return { dispose: () => { dataListeners.delete(listener); } } satisfies IDisposable;
            },
            onExit(listener) {
              exitListeners.add(listener);
              if (exitEvent) queueMicrotask(() => listener(exitEvent!));
              return { dispose: () => { exitListeners.delete(listener); } } satisfies IDisposable;
            },
            write(data) {
              if (exited || !child.connected) throw new TuiLensError("PROCESS_EXITED", "PTY worker 已退出");
              child.send({ type: "write", data } satisfies PtyWorkerRequest);
            },
            resize(nextCols, nextRows) {
              if (exited || !child.connected) throw new TuiLensError("PROCESS_EXITED", "PTY worker 已退出");
              cols = nextCols;
              rows = nextRows;
              child.send({ type: "resize", cols: nextCols, rows: nextRows } satisfies PtyWorkerRequest);
            },
            pause() {
              if (!exited && child.connected) child.send({ type: "pause" } satisfies PtyWorkerRequest);
            },
            resume() {
              if (!exited && child.connected) child.send({ type: "resume" } satisfies PtyWorkerRequest);
            },
            kill(killSignal) {
              if (exited || !child.connected) return;
              child.send({
                type: "kill",
                ...(killSignal === undefined ? {} : { signal: killSignal }),
              } satisfies PtyWorkerRequest);
            },
            dispose: terminate,
          };
          resolved = true;
          resolve(handle);
          return;
        case "data":
          emitData(event.data);
          return;
        case "exit":
          emitExit({ exitCode: event.exitCode, ...(event.signal === undefined ? {} : { signal: event.signal }) });
          clearReadiness();
          return;
        case "error":
          fail(new TuiLensError("PROCESS_START_FAILED", "PTY worker 报告启动或运行错误", {
            reason: event.message,
          }));
          return;
      }
    };

    child.on("message", (message: PtyWorkerEvent) => handleMessage(message));
    child.once("error", fail);
    child.once("exit", (code, exitSignal) => {
      clearReadiness();
      if (!ready) {
        fail(new TuiLensError("PROCESS_START_FAILED", "PTY worker 在 ready 前退出", {
          exitCode: code,
          ...(exitSignal === null ? {} : { signal: exitSignal }),
        }));
        return;
      }
      emitExit({ exitCode: code ?? 1 });
    });
    timer = setTimeout(() => {
      fail(new TuiLensError("PROCESS_START_FAILED", "PTY worker 未能及时 ready", { timeoutMs: 10_000 }));
    }, 10_000);
    abort = () => {
      fail(new TuiLensError("ABORTED", "PTY worker 启动已取消"));
    };
    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener("abort", abort, { once: true });
    try {
      child.send({ type: "spawn", options } satisfies PtyWorkerRequest, (error) => {
        if (error) fail(error);
      });
    } catch (error) {
      fail(error);
    }
  });
}
