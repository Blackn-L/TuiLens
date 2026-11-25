import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { TuiLensError } from "../src/core/errors.js";
import type { Observation, SessionInfo } from "../src/core/types.js";
import { mcpImageContent } from "../src/interfaces/mcp.js";
import { buildMcpConfig, MCP_CONFIG_CLIENTS, MCP_CONFIG_MODES } from "../src/interfaces/mcp-config.js";
import { McpProgressForwarder } from "../src/interfaces/mcp-progress.js";
import { MCP_SCREENSHOT_MAX_BYTES, readArtifactResource } from "../src/interfaces/mcp-resources.js";
import { VERSION } from "../src/version.js";

const run = promisify(execFile);
const cli = fileURLToPath(new URL("../src/interfaces/cli.js", import.meta.url));
const fixture = fileURLToPath(new URL("./fixtures/terminal.js", import.meta.url));

interface McpProgress {
  progress: number;
  total?: number;
  message?: string;
}

test("JSON CLI 跨进程会话与 MCP 共享核心，断开回收拥有的会话", { timeout: 90000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), "tuilens-interface-"));
  const env = { ...process.env, TUILENS_HOME: home, TUILENS_LANG: "en" };
  const call = async (method: string, params = {}): Promise<unknown> => {
    const result = await run(process.execPath, [cli, method, "--json", JSON.stringify(params)], {
      env,
      maxBuffer: 20 * 1024 * 1024,
    });
    const payload = JSON.parse(result.stdout) as { ok: boolean; data: unknown };
    assert.equal(payload.ok, true, result.stdout);
    return payload.data;
  };
  let client: Client | undefined;
  try {
    const session = (await call("launch", {
      command: "node",
      args: [fixture],
      cols: 60,
      rows: 12,
      recording: {},
    })) as SessionInfo;
    assert.equal(session.renderer, "headless");
    await call("wait", { id: session.id, conditions: [{ kind: "text", text: "TUILENS_READY" }] });
    const clicked = await run(
      process.execPath,
      [
        cli,
        "click-text",
        "--json",
        JSON.stringify({
          id: session.id,
          text: "TUILENS_READY",
          options: { selection: "unique" },
        }),
      ],
      { env, maxBuffer: 20 * 1024 * 1024 }
    );
    const clickPayload = JSON.parse(clicked.stdout) as { ok: boolean; error?: { code?: string } };
    assert.equal(clickPayload.ok, true, clicked.stdout);
    assert.notEqual(clickPayload.error?.code, "UNKNOWN_METHOD");
    const waitedInput = await run(
      process.execPath,
      [
        cli,
        "input-wait",
        "--json",
        JSON.stringify({
          id: session.id,
          action: { type: "text", text: "PING" },
          wait: { conditions: [{ kind: "text", text: "INPUT_RECEIVED" }], timeoutMs: 5000 },
        }),
      ],
      { env, maxBuffer: 20 * 1024 * 1024 }
    );
    const waitedPayload = JSON.parse(waitedInput.stdout) as { ok: boolean; error?: { code?: string } };
    assert.equal(waitedPayload.ok, true, waitedInput.stdout);
    assert.notEqual(waitedPayload.error?.code, "UNKNOWN_METHOD");
    const observation = (await call("observe", { id: session.id, screenshot: true })) as Observation;
    assert.equal(observation.session.renderer, "dom");
    assert.equal(observation.snapshot.frameId, observation.screenshot?.frameId);
    assert.match(observation.snapshot.text, /中文 🚀 A⠀B/u);
    assert.deepEqual(
      [...(await readFile(observation.screenshot!.path)).subarray(0, 8)],
      [137, 80, 78, 71, 13, 10, 26, 10]
    );
    const diffObserve = await run(
      process.execPath,
      [cli, "observe", session.id, "--view", "diff", "--from-frame", String(observation.snapshot.frameId)],
      { env, maxBuffer: 20 * 1024 * 1024 }
    );
    const diffPayload = JSON.parse(diffObserve.stdout) as {
      ok: boolean;
      data: { diff?: { omittedSnapshotText?: boolean }; snapshot: { text?: string } };
    };
    assert.equal(diffPayload.ok, true, diffObserve.stdout);
    assert.equal(diffPayload.data.diff?.omittedSnapshotText, true);
    assert.equal(diffPayload.data.snapshot.text, "");
    const watched = await run(process.execPath, [cli, "watch", session.id, "--interval", "50", "--timeout", "350"], {
      env,
      maxBuffer: 20 * 1024 * 1024,
    });
    const watchLines = watched.stdout
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as {
            ok: boolean;
            data: { stopped?: boolean; snapshot?: { cells?: unknown } };
          }
      );
    assert.ok(watchLines.length >= 2);
    assert.ok(watchLines.some((line) => line.data.stopped === true));
    assert.ok(watchLines.some((line) => line.data.snapshot !== undefined && line.data.snapshot.cells === undefined));
    const shortLived = (await call("launch", {
      command: process.execPath,
      args: ["-e", "process.stdout.write('WATCH_EXIT\\n');setTimeout(()=>process.exit(0),100)"],
      cols: 40,
      rows: 8,
    })) as SessionInfo;
    await call("wait", { id: shortLived.id, conditions: [{ kind: "exited" }], timeoutMs: 5000 });
    const exitedWatch = await run(
      process.execPath,
      [cli, "watch", shortLived.id, "--interval", "50", "--timeout", "0"],
      {
        env,
        timeout: 5000,
        maxBuffer: 20 * 1024 * 1024,
      }
    );
    const exitWatchLines = exitedWatch.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { ok: boolean; data: { stopped?: boolean } });
    assert.ok(exitWatchLines.some((line) => line.data.stopped === true));
    await call("close", { id: shortLived.id });
    const crop = (await call("observe", {
      id: session.id,
      screenshot: true,
      region: { x: 0, y: 0, width: 12, height: 2 },
    })) as Observation;
    assert.ok(crop.screenshot!.width < observation.screenshot!.width);
    const comparison = (await call("compare", {
      id: session.id,
      options: { baseline: crop.screenshot!.path, region: { x: 0, y: 0, width: 12, height: 2 } },
    })) as { pass: boolean; renderer?: string };
    assert.equal(comparison.pass, true);
    assert.equal(comparison.renderer, "dom");
    await call("input", { id: session.id, action: { type: "text", text: "PING" } });
    await call("wait", { id: session.id, conditions: [{ kind: "text", text: "INPUT_RECEIVED" }] });
    await call("resize", { id: session.id, cols: 80, rows: 16 });
    await call("wait", { id: session.id, conditions: [{ kind: "text", text: "SIZE_80_16" }] });
    const metrics = (await call("metrics", { id: session.id })) as { receivedBytes: number; appliedBytes: number };
    assert.ok(metrics.receivedBytes > 0);
    assert.ok(metrics.appliedBytes <= metrics.receivedBytes);
    await call("input", { id: session.id, action: { type: "key", key: "Ctrl+q" } });
    await call("wait", { id: session.id, conditions: [{ kind: "exited" }] });
    const replayed = (await call("replay", { path: session.recordingPath })) as {
      snapshot: { cols: number; rows: number };
      renderer?: string;
    };
    assert.equal(replayed.snapshot.cols, 80);
    assert.equal(replayed.snapshot.rows, 16);
    assert.equal(replayed.renderer, "dom");
    await call("close", { id: session.id });
    assert.deepEqual(await call("list"), []);

    client = new Client({ name: "tuilens-test", version: "1" });
    const inherited = Object.fromEntries(Object.entries(env).filter((e): e is [string, string] => e[1] !== undefined));
    await client.connect(
      new StdioClientTransport({ command: process.execPath, args: [cli, "mcp"], env: inherited, stderr: "pipe" })
    );
    assert.deepEqual(client.getServerVersion(), { name: "tuilens", version: VERSION });
    assert.match(client.getInstructions() ?? "", /preferred tool for interactive terminal\/TUI work/u);
    const tools = await client.listTools();
    const expectedTools = [
      "terminal_launch",
      "terminal_list",
      "terminal_observe",
      "terminal_input",
      "terminal_inputAndWait",
      "terminal_find",
      "terminal_clickText",
      "terminal_resize",
      "terminal_wait",
      "terminal_metrics",
      "terminal_close",
      "terminal_compare",
      "terminal_replay",
      "terminal_scenario",
      "terminal_perf",
    ];
    assert.equal(tools.tools.length, 15);
    assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), expectedTools.sort());
    const launchTool = tools.tools.find((tool) => tool.name === "terminal_launch");
    const observeTool = tools.tools.find((tool) => tool.name === "terminal_observe");
    assert.ok(launchTool);
    assert.ok(observeTool);
    assert.equal((launchTool.inputSchema.properties as Record<string, unknown> | undefined)?.images, undefined);
    assert.match(observeTool.description ?? "", /fromFrameId/u);
    assert.match(observeTool.description ?? "", /inputAndWait/u);
    const launch = await client.callTool({
      name: "terminal_launch",
      arguments: { command: process.execPath, args: [fixture], cols: 60, rows: 12, colorMode: "truecolor" },
    });
    const launchContent = launch.content as { type: string; text?: string }[];
    assert.notEqual(launch.isError, true, launchContent[0]?.text ?? "MCP launch failed");
    const mcpSession = JSON.parse(launchContent[0]!.text!) as SessionInfo;
    const progress: McpProgress[] = [];
    const waiting = await client.callTool(
      {
        name: "terminal_wait",
        arguments: { id: mcpSession.id, conditions: [{ kind: "text", text: "TUILENS_READY" }] },
      },
      undefined,
      { onprogress: (item) => progress.push(item as McpProgress) }
    );
    assert.notEqual(waiting.isError, true);
    assert.ok(progress.length >= 1);
    assert.equal(progress[0]?.progress, 0);
    assert.equal(progress[0]?.total, 10_000);
    assert.match(progress[0]?.message ?? "", /wait/u);
    const abort = new AbortController();
    const cancelled = client.callTool(
      {
        name: "terminal_wait",
        arguments: { id: mcpSession.id, conditions: [{ kind: "text", text: "NEVER_MCP_EVIDENCE" }], timeoutMs: 10_000 },
      },
      undefined,
      { signal: abort.signal }
    );
    setTimeout(() => abort.abort(), 100);
    await assert.rejects(cancelled, (error: unknown) => error instanceof Error);
    const inputProgress: McpProgress[] = [];
    const confirmed = await client.callTool(
      {
        name: "terminal_inputAndWait",
        arguments: {
          id: mcpSession.id,
          action: { type: "text", text: "PING" },
          wait: { conditions: [{ kind: "text", text: "INPUT_RECEIVED" }], timeoutMs: 5000 },
          screenshot: true,
        },
      },
      undefined,
      { onprogress: (item) => inputProgress.push(item as McpProgress) }
    );
    assert.notEqual(confirmed.isError, true);
    assert.ok(inputProgress.length >= 1);
    assert.ok(inputProgress.every((item) => item.total !== undefined && item.total > 0));
    assert.ok(inputProgress.some((item) => item.message?.includes("inputAndWait")));
    const confirmedContent = confirmed.content as { type: string; text?: string }[];
    assert.ok(confirmedContent.some((item) => item.type === "image"));
    const confirmedData = JSON.parse(confirmedContent[0]!.text!) as {
      inputFrameId: number;
      observation: { snapshot: { frameId: number; text: string } };
    };
    assert.ok(confirmedData.observation.snapshot.frameId > confirmedData.inputFrameId);
    assert.match(confirmedData.observation.snapshot.text, /INPUT_RECEIVED/u);
    const captured = await client.callTool({
      name: "terminal_observe",
      arguments: { id: mcpSession.id, screenshot: true },
    });
    assert.notEqual(captured.isError, true);
    const capturedContent = captured.content as { type: string; text?: string }[];
    assert.ok(capturedContent.some((item) => item.type === "image"));
    const capturedData = JSON.parse(capturedContent[0]!.text!) as Observation;

    const resources = await client.listResources();
    const resourceUris = new Set(resources.resources.map((resource) => resource.uri));
    assert.ok(resourceUris.has("tuilens://sessions"));
    assert.ok(resourceUris.has(`tuilens://sessions/${mcpSession.id}/screen`));
    assert.ok(resourceUris.has(`tuilens://sessions/${mcpSession.id}/screenshot`));
    assert.ok(resourceUris.has(`tuilens://sessions/${mcpSession.id}/metrics`));
    assert.ok(resources.resources.some((resource) => resource.uri.startsWith("tuilens://artifacts/")));
    const templates = await client.listResourceTemplates();
    assert.deepEqual(
      templates.resourceTemplates.map((template) => template.uriTemplate).sort(),
      [
        "tuilens://artifacts/{name}",
        "tuilens://sessions/{id}/metrics",
        "tuilens://sessions/{id}/screen",
        "tuilens://sessions/{id}/screenshot",
      ].sort()
    );

    const readText = async (uri: string): Promise<string> => {
      const result = await client!.readResource({ uri });
      const first = result.contents[0]!;
      assert.ok("text" in first, `resource ${uri} should return text`);
      return first.text;
    };
    const sessionList = JSON.parse(await readText("tuilens://sessions")) as Record<string, unknown>[];
    const safeSession = sessionList.find((item) => item.id === mcpSession.id);
    assert.ok(safeSession);
    assert.equal("resolvedCommand" in safeSession, false);
    assert.equal("recordingPath" in safeSession, false);
    assert.match(await readText(`tuilens://sessions/${mcpSession.id}/screen`), /INPUT_RECEIVED/u);
    const resourceMetrics = JSON.parse(await readText(`tuilens://sessions/${mcpSession.id}/metrics`)) as {
      receivedBytes: number;
    };
    assert.ok(resourceMetrics.receivedBytes > 0);
    const screenshotResource = await client.readResource({
      uri: `tuilens://sessions/${mcpSession.id}/screenshot`,
    });
    const screenshotPart = screenshotResource.contents[0]!;
    assert.ok("blob" in screenshotPart);
    assert.deepEqual([...Buffer.from(screenshotPart.blob, "base64").subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    assert.ok(capturedData.screenshot);
    const artifactName = basename(capturedData.screenshot.path);
    const artifactResource = await client.readResource({
      uri: `tuilens://artifacts/${encodeURIComponent(artifactName)}`,
    });
    const artifactPart = artifactResource.contents[0]!;
    assert.ok("blob" in artifactPart);
    assert.deepEqual([...Buffer.from(artifactPart.blob, "base64").subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    await assert.rejects(client.readResource({ uri: "tuilens://artifacts/..%2Fdaemon.json" }));
    await assert.rejects(client.readResource({ uri: "tuilens://artifacts/%2Fetc%2Fpasswd" }));

    const prompts = await client.listPrompts();
    assert.deepEqual(prompts.prompts.map((prompt) => prompt.name).sort(), [
      "tui_reproduce_bug",
      "tui_visual_regression",
    ]);
    const reproduce = await client.getPrompt({
      name: "tui_reproduce_bug",
      arguments: { description: "The menu never opens", command: "node tui.js" },
    });
    const reproduceContent = reproduce.messages[0]!.content;
    assert.equal(reproduceContent.type, "text");
    assert.match("text" in reproduceContent ? reproduceContent.text : "", /terminal_launch/u);

    const replayProgress: McpProgress[] = [];
    const replayedMcp = await client.callTool(
      { name: "terminal_replay", arguments: { path: session.recordingPath } },
      undefined,
      { onprogress: (item) => replayProgress.push(item as McpProgress) }
    );
    assert.notEqual(replayedMcp.isError, true);
    assert.ok(replayProgress.length >= 2);
    assert.ok(replayProgress.every((item) => item.total !== undefined && item.total > 0));
    assert.equal(replayProgress.at(-1)?.progress, replayProgress.at(-1)?.total);
    assert.ok(replayProgress.some((item) => item.message?.includes("replay")));
    const lateLaunch = client
      .callTool({
        name: "terminal_launch",
        arguments: { command: process.execPath, args: [fixture], cols: 60, rows: 12 },
      })
      .catch(() => undefined);
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

test("CLI scroll 拒绝顶/底与方向或数量冲突", async () => {
  const home = await mkdtemp(join(tmpdir(), "tuilens-scroll-conflict-"));
  try {
    const result = await run(
      process.execPath,
      [cli, "scroll", "00000000-0000-4000-8000-000000000000", "0", "0", "up", "--top"],
      { env: { ...process.env, TUILENS_HOME: home }, maxBuffer: 1024 * 1024 }
    ).catch((error: { stdout?: string }) => error);
    const payload = JSON.parse((result as { stdout?: string }).stdout ?? "{}") as {
      ok: boolean;
      error?: { code?: string };
    };
    assert.equal(payload.ok, false);
    assert.equal(payload.error?.code, "INVALID_ARGUMENT");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("mcp-config 覆盖所有客户端与启动模式并输出可粘贴格式", async () => {
  for (const client of MCP_CONFIG_CLIENTS) {
    for (const mode of MCP_CONFIG_MODES) {
      const result = buildMcpConfig({ client, mode });
      assert.equal(result.client, client);
      assert.equal(result.mode, mode);
      if (client === "codex") {
        assert.equal(result.format, "toml");
        assert.match(result.content, /^\[mcp_servers\.tuilens\]\n/u);
        assert.match(result.content, /^args = \[/mu);
      } else if (client === "claude-code") {
        assert.equal(result.format, "command");
        assert.match(result.content, /^claude mcp add --scope user tuilens -- /u);
      } else {
        assert.equal(result.format, "json");
        const parsed = JSON.parse(result.content) as {
          mcpServers: { tuilens: { command: string; args: string[] } };
        };
        const server = parsed.mcpServers.tuilens;
        if (mode === "global") {
          assert.deepEqual(server, { command: "tuilens", args: ["mcp"] });
        } else if (mode === "npx") {
          assert.deepEqual(server, { command: "npx", args: ["-y", "tuilens", "mcp"] });
        } else {
          assert.equal(server.command, process.execPath);
          assert.match(server.args[0]!, /cli\.js$/u);
          assert.deepEqual(server.args.slice(1), ["mcp"]);
        }
      }
    }
  }
  const windows = process.platform === "win32";
  const fixtureExecPath = windows ? "C:\\Program Files\\nodejs\\node.exe" : "/opt/node path/node";
  const fixtureCliPath = windows
    ? "C:\\Tui Lens\\dist\\src\\interfaces\\cli.js"
    : "/opt/Tui Lens/dist/src/interfaces/cli.js";
  const absolute = buildMcpConfig({
    client: "claude-code",
    mode: "absolute",
    execPath: fixtureExecPath,
    cliPath: fixtureCliPath,
  });
  if (windows) {
    assert.match(absolute.content, /"C:\\Program Files\\nodejs\\node\.exe"/u);
    assert.match(absolute.content, /"C:\\Tui Lens\\dist\\src\\interfaces\\cli\.js" mcp$/u);
  } else {
    assert.match(absolute.content, /'\/opt\/node path\/node'/u);
    assert.match(absolute.content, /'\/opt\/Tui Lens\/dist\/src\/interfaces\/cli\.js' mcp$/u);
  }
  assert.throws(
    () => buildMcpConfig({ client: "unknown" }),
    (error: unknown) =>
      error instanceof TuiLensError && error.code === "INVALID_ARGUMENT" && error.messageEn.includes("--client")
  );
  assert.throws(
    () => buildMcpConfig({ mode: "unknown" }),
    (error: unknown) =>
      error instanceof TuiLensError && error.code === "INVALID_ARGUMENT" && error.messageEn.includes("--mode")
  );

  const cliCases = [
    { client: "json", mode: "absolute", pattern: /^\{/u },
    { client: "codex", mode: "global", pattern: /^\[mcp_servers\.tuilens\]\n/u },
    {
      client: "claude-code",
      mode: "npx",
      pattern: /^claude mcp add --scope user tuilens -- npx -y tuilens mcp\n?$/u,
    },
  ];
  for (const item of cliCases) {
    const result = await run(process.execPath, [cli, "mcp-config", "--client", item.client, "--mode", item.mode], {
      maxBuffer: 1024 * 1024,
    });
    assert.match(result.stdout, item.pattern);
  }
});

test("MCP 进度转发按 profile 去重、节流且有上限", () => {
  let now = 0;
  const sent: { profile: string | undefined; current: number }[] = [];
  const forwarder = new McpProgressForwarder(
    (progress) => sent.push({ profile: progress.profile, current: progress.current }),
    () => now
  );
  const event = (profile: string, current: number) => ({
    kind: "scenario" as const,
    profile,
    current,
    total: 2,
    elapsedMs: current * 10,
  });
  forwarder.offer(event("headless", 1));
  now = 200;
  forwarder.offer(event("headless", 2));
  now = 400;
  forwarder.offer(event("dom", 1));
  now = 600;
  forwarder.offer(event("dom", 2));
  now = 800;
  forwarder.offer(event("headless", 1));
  forwarder.finish();
  assert.deepEqual(sent, [
    { profile: "headless", current: 1 },
    { profile: "headless", current: 2 },
    { profile: "dom", current: 1 },
    { profile: "dom", current: 2 },
  ]);

  const capped: number[] = [];
  const cappedForwarder = new McpProgressForwarder(
    (progress) => capped.push(progress.current),
    () => {
      now += 1000;
      return now;
    }
  );
  for (let current = 1; current <= 500; current += 1) {
    cappedForwarder.offer({
      kind: "perf",
      current,
      total: 500,
      elapsedMs: current,
    });
  }
  cappedForwarder.finish();
  assert.equal(capped.length, 100);
  assert.deepEqual(
    capped.slice(0, 99),
    Array.from({ length: 99 }, (_, index) => index + 1)
  );
  assert.equal(capped.at(-1), 500);
});

test("artifact 资源拒绝路径穿越、符号链接和超限文件", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tuilens-artifact-root-"));
  const outside = await mkdtemp(join(tmpdir(), "tuilens-artifact-outside-"));
  try {
    const artifacts = join(root, "artifacts");
    await mkdir(artifacts);
    await writeFile(join(artifacts, "ok.txt"), "OK");
    assert.equal((await readArtifactResource("ok.txt", artifacts)).data.toString("utf8"), "OK");
    await assert.rejects(readArtifactResource("../daemon.json", artifacts), { code: "INVALID_ARGUMENT" });
    await assert.rejects(readArtifactResource("%2e%2e%2Fdaemon.json", artifacts), { code: "INVALID_ARGUMENT" });
    await assert.rejects(readArtifactResource("/etc/passwd", artifacts), { code: "INVALID_ARGUMENT" });
    await assert.rejects(readArtifactResource("C:\\Windows\\win.ini", artifacts), { code: "INVALID_ARGUMENT" });

    const secret = join(outside, "secret.txt");
    await writeFile(secret, "SECRET");
    try {
      await symlink(secret, join(artifacts, "escape.txt"));
      await assert.rejects(readArtifactResource("escape.txt", artifacts), { code: "INVALID_ARGUMENT" });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EPERM" || code === "EACCES") {
        try {
          await symlink(outside, join(artifacts, "escape-dir"), "junction");
          await assert.rejects(readArtifactResource("escape-dir/secret.txt", artifacts), {
            code: "INVALID_ARGUMENT",
          });
        } catch (junctionError) {
          const junctionCode = (junctionError as NodeJS.ErrnoException).code;
          if (junctionCode === "EPERM" || junctionCode === "EACCES") {
            t.diagnostic("Symlink and junction creation are unavailable on this Windows host.");
          } else {
            throw junctionError;
          }
        }
      } else {
        throw error;
      }
    }

    await writeFile(join(artifacts, "large.txt"), "");
    await truncate(join(artifacts, "large.txt"), 16 * 1024 * 1024 + 1);
    await assert.rejects(readArtifactResource("large.txt", artifacts), { code: "FILE_LIMIT" });
    const largeImage = join(artifacts, "large.png");
    await writeFile(largeImage, "");
    await truncate(largeImage, MCP_SCREENSHOT_MAX_BYTES + 1);
    await assert.rejects(mcpImageContent(largeImage), { code: "FILE_LIMIT" });
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("MCP prompts 随 TUILENS_LANG 提供中文文案", async () => {
  const home = await mkdtemp(join(tmpdir(), "tuilens-mcp-prompts-"));
  const client = new Client({ name: "tuilens-prompts-test", version: "1" });
  try {
    const env = Object.fromEntries(
      Object.entries({ ...process.env, TUILENS_HOME: home, TUILENS_LANG: "zh-CN" }).filter(
        (entry): entry is [string, string] => entry[1] !== undefined
      )
    );
    await client.connect(
      new StdioClientTransport({ command: process.execPath, args: [cli, "mcp"], env, stderr: "pipe" })
    );
    const prompts = await client.listPrompts();
    assert.match(prompts.prompts.find((prompt) => prompt.name === "tui_reproduce_bug")?.description ?? "", /复现/u);
    const result = await client.getPrompt({
      name: "tui_visual_regression",
      arguments: { scenario: "主菜单显示正常", baseline: "baseline.png" },
    });
    const content = result.messages[0]!.content;
    assert.equal(content.type, "text");
    assert.match("text" in content ? content.text : "", /视觉回归/u);
  } finally {
    await client.close();
    await rm(home, { recursive: true, force: true });
  }
});
