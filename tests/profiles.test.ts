import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { SessionManager } from "../src/session/manager.js";
import { listTerminalProfiles, resolveTerminalProfile } from "../src/profiles/index.js";
import { runPerf } from "../src/perf/runner.js";
import type { Observation } from "../src/core/types.js";
import { rewriteProfileReplies } from "../src/session/protocol-replies.js";
import { methodSchemas } from "../src/core/protocol.js";
import { PNG } from "pngjs";

const probe = fileURLToPath(new URL("./fixtures/profile-probe.js", import.meta.url));
const sample = fileURLToPath(new URL("./fixtures/sample-tui.js", import.meta.url));

test("PTY 前置改写能覆盖 ConPTY 等后端产生的 DA1/DA2/XTVERSION 应答", () => {
  const replies = {
    da1: "\x1b[?62;4;22c",
    da2: "\x1b[>0;4000;1c",
    xtversion: "\x1bP>|kitty(0.40.0)\x1b\\",
  };
  assert.equal(
    rewriteProfileReplies(
      "\x1b[?61;6;7;21;22c\x1b[>0;10;1c\x1bP>|OpenConsole\x1b\\\x1b[?1u",
      replies,
      { kitty: 3 },
    ),
    `${replies.da1}${replies.da2}${replies.xtversion}\x1b[?3u`,
  );
});

test("profile 路径、循环与协议字段有明确校验", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tuilens-profile-errors-"));
  try {
    await assert.rejects(resolveTerminalProfile(join(directory, "missing.json")), {
      code: "PROFILE_NOT_FOUND",
    });
    const first = join(directory, "first.json");
    const second = join(directory, "second.json");
    await writeFile(first, JSON.stringify({ name: "first", extends: "second.json" }));
    await writeFile(second, JSON.stringify({ name: "second", extends: "first.json" }));
    await assert.rejects(resolveTerminalProfile(first), { code: "PROFILE_CYCLE" });
    await writeFile(join(directory, "extra.json"), JSON.stringify({ name: "extra", unknown: true }));
    await assert.rejects(resolveTerminalProfile(join(directory, "extra.json")), { code: "INVALID_PROFILE" });
    assert.equal(methodSchemas.launch.safeParse({
      command: "node",
      terminalProfile: "kitty",
      graphics: { sixel: true, kitty: false, iterm: false },
    }).success, true);
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 5 });
  }
});

function readProbe(observation: Observation): {
  environment: Record<string, string>;
  replies: Buffer;
} {
  const environment = /PROFILE_ENV ([A-Za-z0-9+/=]*) ([A-Za-z0-9+/=]*) ([A-Za-z0-9+/=]*) ([A-Za-z0-9+/=]*)/u
    .exec(observation.snapshot.text);
  const replies = /PROFILE_REPLY ([0-9a-f]*)/u.exec(observation.snapshot.text);
  assert.ok(environment, observation.snapshot.text);
  assert.ok(replies, observation.snapshot.text);
  const decode = (value: string): string => Buffer.from(value, "base64").toString("utf8");
  return {
    environment: {
      TERM: decode(environment[1]!),
      TERM_PROGRAM: decode(environment[2]!),
      TERM_PROGRAM_VERSION: decode(environment[3]!),
      COLORTERM: decode(environment[4]!),
    },
    replies: Buffer.from(replies[1]!, "hex"),
  };
}

function expectedReplies(profile: Awaited<ReturnType<typeof resolveTerminalProfile>>): Buffer {
  const keyboard = profile.capabilities.keyboard?.kitty;
  return Buffer.from(
    `${profile.replies.da1 ?? ""}${profile.replies.da2 ?? ""}${profile.replies.xtversion ?? ""}`
      + (keyboard === undefined ? "" : `\x1b[?${keyboard}u`),
    "latin1",
  );
}

test("内置 profile 通过真实 PTY 返回各自的 DA1/DA2/XTVERSION/键盘应答", { timeout: 120_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "tuilens-profiles-"));
  const manager = new SessionManager({ artifactDir: directory, maxSessions: 2 });
  try {
    for (const preset of listTerminalProfiles()) {
      const profile = await resolveTerminalProfile(preset.key);
      const session = await manager.launch({
        command: process.execPath,
        args: [probe],
        cols: 240,
        rows: 20,
        terminalProfile: preset.key,
      });
      try {
        const waited = await manager.wait(session.id, {
          conditions: [{ kind: "text", text: "PROFILE_DONE" }],
          timeoutMs: 15_000,
        });
        const actual = readProbe(waited.observation);
        assert.equal(session.terminalProfile, profile.name, preset.key);
        assert.equal(actual.environment.TERM, profile.env.TERM, `${preset.key}: TERM`);
        assert.equal(actual.environment.TERM_PROGRAM, profile.env.TERM_PROGRAM ?? "", `${preset.key}: TERM_PROGRAM`);
        assert.equal(actual.environment.TERM_PROGRAM_VERSION,
          profile.env.TERM_PROGRAM_VERSION ?? "", `${preset.key}: TERM_PROGRAM_VERSION`);
        assert.equal(actual.environment.COLORTERM, profile.env.COLORTERM ?? "", `${preset.key}: COLORTERM`);
        assert.deepEqual(actual.replies, expectedReplies(profile), `${preset.key}: 应答必须来自 profile`);
      } finally {
        await manager.close(session.id);
      }
    }
  } finally {
    await manager.closeAll();
    await rm(directory, { recursive: true, force: true, maxRetries: 5 });
  }
});

test("外部 profile 用 extends 只覆盖差异字段，并驱动 DA1 与滚动缓冲", { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "tuilens-profile-file-"));
  const manager = new SessionManager({ artifactDir: directory });
  try {
    const path = join(directory, "kitty-sixel.json");
    await writeFile(path, JSON.stringify({
      name: "kitty-sixel",
      extends: "kitty",
      env: { TERM_PROGRAM_VERSION: "0.40.1-custom" },
      capabilities: {
        graphics: { sixel: true },
        keyboard: { kitty: 3 },
        scrollback: 321,
      },
    }));
    const profile = await resolveTerminalProfile(path);
    assert.equal(profile.name, "kitty-sixel");
    assert.equal(profile.env.TERM, "xterm-kitty");
    assert.equal(profile.env.TERM_PROGRAM_VERSION, "0.40.1-custom");
    assert.equal(profile.capabilities.graphics?.kitty, true);
    assert.equal(profile.capabilities.graphics?.sixel, true);
    assert.equal(profile.capabilities.keyboard?.modifyOtherKeys, 2);
    assert.equal(profile.capabilities.keyboard?.kitty, 3);
    assert.equal(profile.capabilities.scrollback, 321);
    assert.equal(profile.replies.da1, "\x1b[?62;4;22c");

    const session = await manager.launch({
      command: process.execPath,
      args: [probe],
      cols: 240,
      rows: 20,
      terminalProfile: path,
    });
    try {
      const waited = await manager.wait(session.id, {
        conditions: [{ kind: "text", text: "PROFILE_DONE" }],
        timeoutMs: 15_000,
      });
      assert.deepEqual(readProbe(waited.observation).replies, expectedReplies(profile));
    } finally {
      await manager.close(session.id);
    }
  } finally {
    await manager.closeAll();
    await rm(directory, { recursive: true, force: true, maxRetries: 5 });
  }
});

test("场景与性能矩阵按 profiles 列表重复同一工作负载", { timeout: 120_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "tuilens-profile-matrix-"));
  const manager = new SessionManager({ artifactDir: directory, maxSessions: 2 });
  try {
    const scenario = await manager.scenario({
      version: 1,
      launch: { command: process.execPath, args: [probe], cols: 100, rows: 20 },
      profiles: ["kitty", "linux"],
      steps: [{ type: "wait", conditions: [{ kind: "text", text: "PROFILE_DONE" }], timeoutMs: 15_000 }],
    });
    assert.ok("matrix" in scenario && scenario.matrix);
    assert.equal(scenario.pass, true);
    assert.deepEqual(scenario.runs.map((run) => run.terminalProfile), ["kitty-0.40", "linux-console-6"]);

    const performance = await runPerf(manager, {
      directory,
      spec: {
        version: 1,
        launch: { command: process.execPath, args: [sample], cols: 40, rows: 8 },
        profiles: ["kitty", "linux"],
        ready: [{ kind: "text", text: "READY" }],
        rounds: 1,
        repeats: 1,
        measure: { processTree: false },
        phases: [{
          name: "matrix",
          samples: [{
            name: "toggle",
            input: { type: "text", text: "g" },
            observe: [{ kind: "text", text: "UPDATED" }],
            timeoutMs: 5000,
          }],
        }],
      },
    });
    assert.ok("matrix" in performance && performance.matrix);
    assert.equal(performance.pass, true);
    assert.deepEqual(performance.profiles, ["kitty", "linux"]);
    assert.equal(performance.table[0]?.values.length, 2);
    assert.deepEqual(
      performance.runs.map((run) => run.environment.terminalProfile),
      ["kitty-0.40", "linux-console-6"],
    );
  } finally {
    await manager.closeAll();
    await rm(directory, { recursive: true, force: true, maxRetries: 5 });
  }
});

test("profile 录制在源文件删除后仍保留图片能力", { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "tuilens-profile-replay-"));
  const manager = new SessionManager({ artifactDir: directory });
  const redSixel = "\x1b[2;3H\x1bPq\"1;1;16;12#1;2;100;0;0#1!16~-!16~\x1b\\";
  const profilePath = join(directory, "sixel.json");
  const redPixels = (buffer: Buffer): number => {
    const png = PNG.sync.read(buffer);
    let count = 0;
    for (let index = 0; index < png.data.length; index += 4) {
      if (png.data[index] === 255 && png.data[index + 1] === 0 && png.data[index + 2] === 0) count += 1;
    }
    return count;
  };
  try {
    await writeFile(profilePath, JSON.stringify({
      name: "sixel", capabilities: { graphics: { sixel: true }, scrollback: 321 },
    }));
    const session = await manager.launch({
      command: process.execPath,
      args: ["-e", `process.stdout.write(${JSON.stringify(redSixel)});setTimeout(()=>{},1000)`],
      cols: 20, rows: 8, terminalProfile: profilePath, recording: {},
    });
    let sessionRed = 0;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const observation = await manager.observe(session.id);
      sessionRed = redPixels(await readFile(observation.screenshot!.path));
      if (sessionRed === 192) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(sessionRed, 192);
    await manager.close(session.id);
    const header = JSON.parse((await readFile(session.recordingPath!, "utf8")).split("\n")[0]!) as {
      images: string; renderer?: string;
      profile: { name: string; env?: unknown; source?: unknown; capabilities: { scrollback: number } };
    };
    assert.equal(header.images, "off");
    assert.equal(header.renderer, "dom");
    assert.equal(header.profile.name, "sixel");
    assert.equal("env" in header.profile, false);
    assert.equal("source" in header.profile, false);
    assert.equal(header.profile.capabilities.scrollback, 321);
    await rm(profilePath);
    const replay = await manager.replay(session.recordingPath!);
    assert.equal(replay.renderer, "dom");
    assert.equal(redPixels(await readFile(replay.screenshot.path)), 192);
  } finally {
    await manager.closeAll();
    await rm(directory, { recursive: true, force: true, maxRetries: 5 });
  }
});

test("单个 profile 失败不会丢弃其他性能矩阵结果", { timeout: 60_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "tuilens-profile-matrix-errors-"));
  const manager = new SessionManager({ artifactDir: directory });
  try {
    const result = await runPerf(manager, {
      directory,
      spec: {
        version: 1,
        launch: { command: process.execPath, args: [sample], cols: 40, rows: 8 },
        profiles: ["missing-profile", "linux"],
        ready: [{ kind: "text", text: "READY" }],
        rounds: 1,
        repeats: 1,
        measure: { processTree: false },
        phases: [{
          name: "matrix",
          samples: [{
            name: "toggle", input: { type: "text", text: "g" },
            observe: [{ kind: "text", text: "UPDATED" }], timeoutMs: 5000,
          }],
        }],
      },
    });
    assert.ok("matrix" in result && result.matrix);
    assert.equal(result.pass, false);
    assert.equal(result.runs.length, 2);
    const [failed, passed] = result.runs;
    assert.ok(failed && "profile" in failed);
    assert.equal(failed.profile, "missing-profile");
    assert.equal(failed.reportPath, null);
    assert.equal(failed.error.code, "PERF_NO_DATA");
    assert.equal(failed.error.messageEn, "The performance run produced no valid round.");
    assert.equal(failed.error.messageZh, "性能运行没有产生任何有效轮次");
    assert.ok(passed && "rounds" in passed);
    assert.equal(passed.pass, true);
    assert.equal(passed.environment.terminalProfile, "linux-console-6");
    assert.equal(result.table.length, 1);
    assert.equal((await readFile(result.reportPath, "utf8")).includes("missing-profile"), true);
  } finally {
    await manager.closeAll();
    await rm(directory, { recursive: true, force: true, maxRetries: 5 });
  }
});
