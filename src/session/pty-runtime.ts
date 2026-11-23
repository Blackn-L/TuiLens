import { fork } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { IDisposable, IPty } from "node-pty";

const require = createRequire(import.meta.url);
const CONPTY_PROCESS_LIST_AGENT = join(dirname(require.resolve("node-pty")), "conpty_console_list_agent.js");
const quietConptyAgents = new WeakSet<object>();

interface WindowsPtyAgent {
  _useConpty?: boolean;
  _useConptyDll?: boolean;
  _innerPid?: number;
  _conoutSocketWorker?: { dispose?: () => void };
  _getConsoleProcessList?: () => Promise<number[]>;
}

/** 会话只依赖这层最小接口，便于在进程内 PTY 与 worker PTY 之间切换。 */
export interface PtyHandle {
  readonly pid: number;
  readonly cols: number;
  readonly rows: number;
  onData(listener: (data: string) => void): IDisposable;
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): IDisposable;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  pause(): void;
  resume(): void;
  kill(signal?: string): void;
  dispose?(): void;
}

/**
 * node-pty 1.1.0 在关闭系统 ConPTY 时 fork 一个辅助进程执行 AttachConsole。
 * 目标控制台已退出时该进程会把异常写进继承的 stderr，且不会发送回复，
 * 父进程只能空等 5 秒超时。保留进程树清理，但改为静默子进程并在退出时立即回退。
 */
export function installWindowsConptyCleanup(pty: IPty): void {
  if (process.platform !== "win32") return;
  const agent = (pty as unknown as { _agent?: WindowsPtyAgent })._agent;
  if (!agent || agent._useConpty !== true || agent._useConptyDll === true || quietConptyAgents.has(agent)) return;
  const shellPid = agent._innerPid;
  if (typeof shellPid !== "number" || !Number.isInteger(shellPid)) return;
  quietConptyAgents.add(agent);
  agent._getConsoleProcessList = () =>
    new Promise<number[]>((resolve) => {
      let child: ReturnType<typeof fork>;
      try {
        child = fork(CONPTY_PROCESS_LIST_AGENT, [String(shellPid)], { silent: true });
      } catch {
        resolve([shellPid]);
        return;
      }
      let settled = false;
      let timer: NodeJS.Timeout | undefined;
      const finish = (pids: number[]): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve([...new Set([shellPid, ...pids])]);
      };
      child.once("message", (message: unknown) => {
        const value =
          message && typeof message === "object" && "consoleProcessList" in message
            ? (message as { consoleProcessList?: unknown }).consoleProcessList
            : undefined;
        const pids = Array.isArray(value) ? value.filter((pid): pid is number => Number.isInteger(pid)) : [];
        finish(pids);
      });
      child.once("error", () => finish([]));
      child.once("exit", () => finish([]));
      child.stdout?.resume();
      child.stderr?.resume();
      timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          /* 辅助进程可能已退出。 */
        }
        finish([]);
      }, 5000);
    });
}

/**
 * node-pty 1.1.0 的 useConptyDll 分支只在 conout 再次收到 data 时释放 worker；
 * 无数据可读时该线程会阻止宿主退出。这里调用其内部可销毁句柄，仅限 Windows。
 */
export function releaseWindowsConptyWorker(pty: IPty): void {
  if (process.platform !== "win32") return;
  const agent = (pty as unknown as { _agent?: WindowsPtyAgent })._agent;
  try {
    agent?._conoutSocketWorker?.dispose?.();
  } catch {
    /* 进程退出路径尽力清理。 */
  }
}

/** 把 node-pty 的 IPty 包成会话接口；dispose 负责释放 Windows ConPTY worker。 */
export function directPty(pty: IPty): PtyHandle {
  return {
    get pid() {
      return pty.pid;
    },
    get cols() {
      return pty.cols;
    },
    get rows() {
      return pty.rows;
    },
    onData: (listener) => pty.onData(listener),
    onExit: (listener) =>
      pty.onExit(({ exitCode, signal }) =>
        listener({
          exitCode,
          ...(signal === undefined ? {} : { signal }),
        })
      ),
    write: (data) => pty.write(data),
    resize: (cols, rows) => pty.resize(cols, rows),
    pause: () => pty.pause(),
    resume: () => pty.resume(),
    kill: (signal) => pty.kill(signal),
    dispose: () => releaseWindowsConptyWorker(pty),
  };
}
