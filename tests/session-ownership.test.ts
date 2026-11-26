import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { SessionInfo } from "../src/core/types.js";

const run = promisify(execFile);
const cli = fileURLToPath(new URL("../src/interfaces/cli.js", import.meta.url));
const fixture = fileURLToPath(new URL("./fixtures/terminal.js", import.meta.url));
const launch = { command: process.execPath, args: [fixture], cols: 40, rows: 8, recording: {} };

async function mcpCall<T>(client: Client, method: string, params = {}, errorCode?: string): Promise<T> {
  const result = await client.callTool({ name: `terminal_${method}`, arguments: params });
  const [content] = result.content as { type: string; text?: string }[];
  assert.equal(content?.type, "text");
  const data = JSON.parse(content!.text!);
  if (errorCode) {
    assert.equal(result.isError, true, method);
    assert.equal(data.code, errorCode, method);
  } else {
    assert.notEqual(result.isError, true, `${method}: ${data.code ?? ""}`);
  }
  return data as T;
}

test("MCP 与 CLI 的会话归属、资源可见性和单次交接", { timeout: 60000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), "tuilens-owner-"));
  const env = Object.fromEntries(
    Object.entries({ ...process.env, TUILENS_HOME: home, TUILENS_LANG: "en" }).filter(
      (item): item is [string, string] => item[1] !== undefined
    )
  );
  async function cliCall<T>(args: string[], stdin?: string): Promise<T> {
    const pending = run(process.execPath, [cli, ...args], { env });
    if (stdin !== undefined) pending.child.stdin!.end(stdin);
    const { stdout } = await pending;
    const result = JSON.parse(stdout);
    assert.equal(result.ok, true, result.error?.code);
    return result.data as T;
  }

  const owner = new Client({ name: "owner", version: "1" });
  const recipient = new Client({ name: "recipient", version: "1" });
  try {
    for (const client of [owner, recipient]) {
      await client.connect(
        new StdioClientTransport({ command: process.execPath, args: [cli, "mcp"], env, stderr: "pipe" })
      );
    }
    assert.ok(
      (await owner.listTools()).tools.some((tool) => tool.name === "terminal_handoff"),
      "MCP must support explicit handoff"
    );
    const cliSession = await cliCall<SessionInfo>(["launch", "--json", JSON.stringify(launch)]);
    const session = await mcpCall<SessionInfo>(owner, "launch", launch);
    const id = session.id;
    assert.deepEqual(
      (await cliCall<SessionInfo[]>(["list"])).map((row) => row.id),
      [cliSession.id]
    );
    assert.deepEqual(
      (await mcpCall<SessionInfo[]>(owner, "list")).map((row) => row.id),
      [id]
    );
    assert.deepEqual(await mcpCall(recipient, "list"), []);

    const metadata = await mcpCall<SessionInfo[]>(recipient, "list", { includeAll: true });
    assert.deepEqual(metadata.map((row) => row.id).sort(), [id, cliSession.id].sort());
    for (const row of metadata) {
      assert.deepEqual(Object.keys(row).sort(), ["cols", "createdAt", "exitCode", "id", "pid", "rows", "status"]);
    }
    const resources = await recipient.listResources();
    assert.ok(!resources.resources.some((item) => item.uri.startsWith(`tuilens://sessions/${id}/`)));
    const directory = (await recipient.readResource({ uri: "tuilens://sessions" })).contents[0];
    assert.ok(directory && "text" in directory);
    assert.deepEqual(JSON.parse(directory.text), []);
    for (const kind of ["screen", "metrics", "screenshot"]) {
      await assert.rejects(
        recipient.readResource({ uri: `tuilens://sessions/${id}/${kind}` }),
        /SESSION_NOT_OWNED|not authorized|未获授权/u
      );
    }
    const denied = "SESSION_NOT_OWNED";
    for (const [method, params] of [
      ["observe", { id }],
      ["input", { id, action: { type: "text", text: "PING" } }],
      ["resize", { id, cols: 50, rows: 10 }],
      ["handoff", { id }],
      ["close", { id }],
    ] as const) {
      await mcpCall(recipient, method, params, denied);
    }

    await mcpCall(owner, "wait", { id, conditions: [{ kind: "text", text: "TUILENS_READY" }] });
    const replaced = await mcpCall<{ token: string }>(owner, "handoff", { id });
    const { token } = await mcpCall<{ token: string }>(owner, "handoff", { id });
    await mcpCall(recipient, "adopt", { id, token: replaced.token }, denied);
    const adopted = await mcpCall<SessionInfo>(recipient, "adopt", { id, token });
    assert.equal(adopted.id, id);
    await mcpCall(owner, "adopt", { id, token }, denied);
    await mcpCall(owner, "close", { id }, denied);

    const cleanupProbe = await mcpCall<SessionInfo>(owner, "launch", launch);
    await owner.close();
    for (let attempt = 0; ; attempt++) {
      const all = await mcpCall<SessionInfo[]>(recipient, "list", { includeAll: true });
      if (!all.some((row) => row.id === cleanupProbe.id)) break;
      assert.ok(attempt < 50, "the former owner's remaining session should be released");
      await sleep(100);
    }
    await mcpCall(recipient, "inputAndWait", {
      id,
      action: { type: "text", text: "PING" },
      wait: { conditions: [{ kind: "text", text: "INPUT_RECEIVED" }] },
    });

    const next = await mcpCall<{ token: string }>(recipient, "handoff", { id });
    assert.equal((await cliCall<SessionInfo>(["adopt", "--stdin"], JSON.stringify({ id, token: next.token }))).id, id);
    await mcpCall(recipient, "metrics", { id }, denied);
    await cliCall(["close", id]);
    const back = await cliCall<{ token: string }>(["handoff", cliSession.id]);
    assert.equal(
      (await mcpCall<SessionInfo>(recipient, "adopt", { id: cliSession.id, token: back.token })).id,
      cliSession.id
    );
    assert.deepEqual(await cliCall(["list"]), []);
    assert.deepEqual(
      (await cliCall<SessionInfo[]>(["list", "--all"])).map((row) => row.id),
      [cliSession.id]
    );
    await mcpCall(recipient, "close", { id: cliSession.id });
  } finally {
    await Promise.allSettled([owner.close(), recipient.close()]);
    await cliCall(["shutdown"]).catch(() => undefined);
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
