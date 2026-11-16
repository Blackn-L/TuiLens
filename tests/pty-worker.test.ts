import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { TerminalEngine } from "../src/core/types.js";
import { SessionManager } from "../src/session/manager.js";
import { spawnIsolatedPty } from "../src/session/pty-worker-client.js";

function inheritedEnv(): Record<string, string> {
  return Object.fromEntries(Object.entries(process.env).filter(
    (entry): entry is [string, string] => entry[1] !== undefined,
  ));
}

test("PTY worker 在独立进程流式返回输出并报告退出", { timeout: 20_000 }, async () => {
  const pty = await spawnIsolatedPty({
    command: process.execPath,
    args: ["-e", "process.stdout.write('WORKER_READY\\n');setTimeout(()=>process.exit(0),60)"],
    name: "xterm-256color",
    cols: 40,
    rows: 6,
    cwd: process.cwd(),
    env: inheritedEnv(),
  });
  let output = "";
  const data = pty.onData((value) => { output += value; });
  try {
    const exit = await new Promise<{ exitCode: number }>((resolve, reject) => {
      const subscription = pty.onExit(resolve);
      const timer = setTimeout(() => {
        subscription.dispose();
        reject(new Error("worker PTY did not exit"));
      }, 5000);
      timer.unref();
    });
    assert.match(output, /WORKER_READY/u);
    assert.equal(exit.exitCode, 0);
    assert.notEqual(pty.pid, process.pid);
  } finally {
    data.dispose();
    pty.dispose?.();
  }
});

test("SessionManager 可通过 worker 启动并关闭 PTY", { timeout: 20_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "tuilens-pty-worker-manager-"));
  const state = {
    cols: 40, rows: 6,
    cursor: { x: 0, y: 0, visible: true, style: "block" as const, blink: false },
    modes: {
      alternateScreen: false, bracketedPaste: false, applicationCursorKeys: false, mouseTracking: "none",
    },
  };
  const engine: TerminalEngine = {
    write: async () => {},
    resize: async () => {},
    state: async () => state,
    snapshot: async (frameId) => ({
      frameId, capturedAt: new Date().toISOString(), cols: 40, rows: 6,
      text: "", lines: [], cells: [], cursor: state.cursor, modes: state.modes,
    }),
    screenshot: async () => ({ png: Buffer.alloc(0), width: 1, height: 1 }),
    close: async () => {},
  };
  const manager = new SessionManager({
    artifactDir: directory,
    ptyWorker: true,
    engineFactory: async () => engine,
  });
  try {
    const session = await manager.launch({
      command: process.execPath,
      args: ["-e", "setInterval(()=>{},1000)"],
      cols: 40,
      rows: 6,
    });
    assert.notEqual(session.pid, process.pid);
    await manager.close(session.id);
    assert.deepEqual(manager.list(), []);
  } finally {
    await manager.closeAll();
    await rm(directory, { recursive: true, force: true });
  }
});
