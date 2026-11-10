import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Observation, SessionInfo } from "../src/core/types.js";

const run = promisify(execFile);
const cli = fileURLToPath(new URL("../src/interfaces/cli.js", import.meta.url));
const fixture = fileURLToPath(new URL("./fixtures/terminal.js", import.meta.url));

test("JSON CLI 跨进程会话与 MCP 共享核心，断开回收拥有的会话", { timeout: 90000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), "tuilens-interface-"));
  const env = { ...process.env, TUILENS_HOME: home };
  const call = async (method: string, params = {}): Promise<unknown> => {
    const result = await run(process.execPath, [cli, method, "--json", JSON.stringify(params)], { env, maxBuffer: 20 * 1024 * 1024 });
    const payload = JSON.parse(result.stdout) as { ok: boolean; data: unknown };
    assert.equal(payload.ok, true, result.stdout);
    return payload.data;
  };
  let client: Client | undefined;
  try {
    const session = await call("launch", { command: "node", args: [fixture], cols: 60, rows: 12, recording: {} }) as SessionInfo;
    await call("wait", { id: session.id, conditions: [{ kind: "text", text: "TUILENS_READY" }] });
    const clicked = await run(process.execPath, [cli, "click-text", "--json", JSON.stringify({
      id: session.id, text: "TUILENS_READY", options: { selection: "unique" },
    })], { env, maxBuffer: 20 * 1024 * 1024 });
    const clickPayload = JSON.parse(clicked.stdout) as { ok: boolean; error?: { code?: string } };
    assert.equal(clickPayload.ok, true, clicked.stdout);
    assert.notEqual(clickPayload.error?.code, "UNKNOWN_METHOD");
    const waitedInput = await run(process.execPath, [cli, "input-wait", "--json", JSON.stringify({
      id: session.id,
      action: { type: "text", text: "PING" },
      wait: { conditions: [{ kind: "text", text: "INPUT_RECEIVED" }], timeoutMs: 5000 },
    })], { env, maxBuffer: 20 * 1024 * 1024 });
    const waitedPayload = JSON.parse(waitedInput.stdout) as { ok: boolean; error?: { code?: string } };
    assert.equal(waitedPayload.ok, true, waitedInput.stdout);
    assert.notEqual(waitedPayload.error?.code, "UNKNOWN_METHOD");
    const observation = await call("observe", { id: session.id }) as Observation;
    assert.equal(observation.snapshot.frameId, observation.screenshot?.frameId);
    assert.match(observation.snapshot.text, /中文 🚀 A⠀B/u);
    assert.deepEqual([...((await readFile(observation.screenshot!.path)).subarray(0, 8))], [137, 80, 78, 71, 13, 10, 26, 10]);
    const crop = await call("observe", { id: session.id, region: { x: 0, y: 0, width: 12, height: 2 } }) as Observation;
    assert.ok(crop.screenshot!.width < observation.screenshot!.width);
    const comparison = await call("compare", { id: session.id, options: { baseline: crop.screenshot!.path,
      region: { x: 0, y: 0, width: 12, height: 2 } } }) as { pass: boolean };
    assert.equal(comparison.pass, true);
    await call("input", { id: session.id, action: { type: "text", text: "PING" } });
    await call("wait", { id: session.id, conditions: [{ kind: "text", text: "INPUT_RECEIVED" }] });
    await call("resize", { id: session.id, cols: 80, rows: 16 });
    await call("wait", { id: session.id, conditions: [{ kind: "text", text: "SIZE_80_16" }] });
    const metrics = await call("metrics", { id: session.id }) as { receivedBytes: number; appliedBytes: number };
    assert.ok(metrics.receivedBytes > 0);
    assert.ok(metrics.appliedBytes <= metrics.receivedBytes);
    await call("input", { id: session.id, action: { type: "key", key: "Ctrl+q" } });
    await call("wait", { id: session.id, conditions: [{ kind: "exited" }] });
    const replayed = await call("replay", { path: session.recordingPath }) as { snapshot: { cols: number; rows: number } };
    assert.equal(replayed.snapshot.cols, 80);
    assert.equal(replayed.snapshot.rows, 16);
    await call("close", { id: session.id });
    assert.deepEqual(await call("list"), []);

    client = new Client({ name: "tuilens-test", version: "1" });
    const inherited = Object.fromEntries(Object.entries(env).filter((e): e is [string, string] => e[1] !== undefined));
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [cli, "mcp"], env: inherited, stderr: "pipe" }));
    assert.deepEqual(client.getServerVersion(), { name: "tuilens", version: "0.4.0" });
    const tools = await client.listTools();
    const expectedTools = [
      "terminal_launch", "terminal_list", "terminal_observe", "terminal_input", "terminal_inputAndWait",
      "terminal_find", "terminal_clickText", "terminal_resize", "terminal_wait", "terminal_metrics",
      "terminal_close", "terminal_compare", "terminal_replay", "terminal_scenario",
    ];
    assert.equal(tools.tools.length, 14);
    assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), expectedTools.sort());
    const launch = await client.callTool({ name: "terminal_launch", arguments: { command: process.execPath, args: [fixture], cols: 60, rows: 12 } });
    const launchContent = launch.content as { type: string; text?: string }[];
    const mcpSession = JSON.parse(launchContent[0]!.text!) as SessionInfo;
    const waiting = await client.callTool({ name: "terminal_wait", arguments: { id: mcpSession.id, conditions: [{ kind: "text", text: "TUILENS_READY" }] } });
    assert.notEqual(waiting.isError, true);
    const confirmed = await client.callTool({
      name: "terminal_inputAndWait",
      arguments: {
        id: mcpSession.id,
        action: { type: "text", text: "PING" },
        wait: { conditions: [{ kind: "text", text: "INPUT_RECEIVED" }], timeoutMs: 5000 },
        screenshot: true,
      },
    });
    assert.notEqual(confirmed.isError, true);
    const confirmedContent = confirmed.content as { type: string; text?: string }[];
    assert.ok(confirmedContent.some((item) => item.type === "image"));
    const confirmedData = JSON.parse(confirmedContent[0]!.text!) as {
      inputFrameId: number;
      observation: { snapshot: { frameId: number; text: string } };
    };
    assert.ok(confirmedData.observation.snapshot.frameId > confirmedData.inputFrameId);
    assert.match(confirmedData.observation.snapshot.text, /INPUT_RECEIVED/u);
    const captured = await client.callTool({ name: "terminal_observe", arguments: { id: mcpSession.id } });
    assert.notEqual(captured.isError, true);
    assert.ok((captured.content as { type: string }[]).some((item) => item.type === "image"));
    const lateLaunch = client.callTool({ name: "terminal_launch", arguments: { command: process.execPath, args: [fixture], cols: 60, rows: 12 } }).catch(() => undefined);
    await sleep(50);
    await client.close();
    await lateLaunch;
    client = undefined;
    let remaining: unknown = null;
    for (let i = 0; i < 100; i += 1) {
      remaining = await call("list");
      if (Array.isArray(remaining) && !remaining.length) break;
      await sleep(100);
    }
    assert.deepEqual(remaining, [], "MCP 断开后不能留下孤儿会话");
    await sleep(1200);
    assert.deepEqual(await call("list"), [], "迟到 launch 也必须回收");
  } finally {
    await client?.close();
    await call("shutdown").catch(() => undefined);
    // 所有路径均来自 mkdtemp，不涉及用户目录。
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
