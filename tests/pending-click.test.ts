import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { SessionManager } from "../src/session/manager.js";
import { TuiLensError } from "../src/core/errors.js";

test("真实 PTY 未提交同步帧允许显式点击并保留默认保护", { timeout: 30000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "tuilens-pending-click-"));
  const manager = new SessionManager({ artifactDir: directory });
  const fixture = fileURLToPath(new URL("./fixtures/pending-click.js", import.meta.url));
  try {
    const session = await manager.launch({ command: process.execPath, args: [fixture], cols: 20, rows: 5 });
    const deadline = Date.now() + 2000;
    for (;;) {
      try {
        await manager.clickText(session.id, "Run", undefined, { allowPendingFrame: true });
        break;
      } catch (error) {
        if (!(error instanceof TuiLensError) || error.code !== "NO_MATCH" || Date.now() >= deadline) throw error;
        await new Promise<void>((resolve) => setTimeout(resolve, 25));
      }
    }
    const clicked = await manager.wait(session.id, { conditions: [{ kind: "text", text: "CLICKED" }], timeoutMs: 5000 });
    assert.match(clicked.observation.snapshot.text, /CLICKED/u);
    await manager.input(session.id, { type: "key", key: "Ctrl+q" });
    await manager.wait(session.id, { conditions: [{ kind: "exited" }], timeoutMs: 5000 });
    await manager.close(session.id);
  } finally {
    await manager.closeAll();
    await rm(directory, { recursive: true, force: true });
  }
});
