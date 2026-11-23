import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { SessionManager } from "../src/session/manager.js";
import { runPerf } from "../src/perf/runner.js";
import { collectTree, parseDarwinProcessTable } from "../src/perf/resource.js";
import { summarize } from "../src/perf/stats.js";

const execute = promisify(execFile);

const fixture = [
  "-e",
  String.raw`
process.stdin.setRawMode(true);
let n = 0;
const dump = () => process.stdout.write("\x1b[H\x1b[2JTURN_" + n);
dump();
process.stdin.on("data", (chunk) => {
  if (!chunk.toString().includes("x")) return;
  n += 1;
  dump();
});
process.stdin.resume();
`,
];

test("分位数统计保留极值并处理单样本", () => {
  assert.deepEqual(summarize([]), { count: 0, min: 0, p50: 0, p95: 0, p99: 0, max: 0, mean: 0 });
  assert.deepEqual(summarize([7]), { count: 1, min: 7, p50: 7, p95: 7, p99: 7, max: 7, mean: 7 });
  const summary = summarize([1, 2, 3, 4, 5]);
  assert.equal(summary.min, 1);
  assert.equal(summary.max, 5);
  assert.equal(summary.p50, 3);
  assert.equal(summary.mean, 3);
  // 输入数组不能被排序副作用破坏。
  const values = [3, 1, 2];
  summarize(values);
  assert.deepEqual(values, [3, 1, 2]);
});

test("macOS ps 输出按 KiB 转换并构建完整进程树", () => {
  const records = parseDarwinProcessTable(
    ["  100   1  1000", "  200 100  2000", "  300 200  3000", "  400   1  4000", "malformed"].join("\n")
  );
  assert.deepEqual(records[0], { pid: 100, parentPid: 1, rssBytes: 1_024_000 });
  const tree = collectTree(records, 100);
  assert.deepEqual(
    tree.map((record) => record.pid),
    [100, 200, 300]
  );
  assert.equal(
    tree.reduce((total, record) => total + record.rssBytes, 0),
    6_144_000
  );
});

test("macOS 真实 ps 采样包含当前进程", { skip: process.platform !== "darwin" }, async () => {
  const { stdout } = await execute("ps", ["-eo", "pid=,ppid=,rss="], { maxBuffer: 16 * 1024 * 1024 });
  const records = parseDarwinProcessTable(stdout);
  const current = records.find((record) => record.pid === process.pid);
  assert.ok(current);
  assert.ok(current.rssBytes > 0);
});

test("性能场景按模板等待每次新证据，并能写出可比较的基线", { timeout: 120_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "tuilens-perf-"));
  const manager = new SessionManager({ artifactDir: directory });
  try {
    const spec = {
      version: 1,
      launch: { command: process.execPath, args: fixture, cols: 40, rows: 8 },
      ready: [{ kind: "text", text: "TURN_0" }],
      rounds: 2,
      repeats: 2,
      phases: [
        {
          name: "add",
          samples: [
            {
              name: "add-turn",
              input: { type: "text", text: "x" },
              observe: [{ kind: "text", text: "TURN_{{seq}}" }],
              timeoutMs: 5000,
            },
          ],
        },
      ],
    };
    const baselinePath = join(directory, "baseline.json");
    const first = await runPerf(manager, { spec, directory, writeBaseline: baselinePath });
    assert.ok(!("matrix" in first));
    assert.equal(first.pass, true);
    assert.equal(first.environment.renderer, "dom");
    assert.equal(first.processTree.errors, 0);
    assert.ok(first.processTree.peakRootRssBytes > 0);
    // 2 轮 × 2 次重复 = 4 个样本。
    assert.equal(first.metrics.length, 1);
    assert.equal(first.metrics[0]!.samples, 4);
    assert.ok(first.metrics[0]!.elapsedMs.p50 > 0);
    assert.equal(first.rounds.length, 2);
    assert.deepEqual(first.errors, []);
    const baseline = JSON.parse(await readFile(baselinePath, "utf8")) as {
      version: number;
      environment: { renderer?: string };
      metrics: { phase: string; name: string; p50: number }[];
    };
    assert.equal(baseline.version, 1);
    assert.equal(baseline.environment.renderer, "dom");
    assert.equal(baseline.metrics[0]?.phase, "add");
    assert.equal(baseline.metrics[0]?.name, "add-turn");

    // 与同一环境基线比较时，不应把正常波动当作回归。
    const second = await runPerf(manager, { spec, directory, baseline: baselinePath, maxRegression: 10 });
    assert.ok(!("matrix" in second));
    assert.equal(second.comparisons.length, 1);
    assert.equal(second.comparisons[0]!.baselineP50, baseline.metrics[0]!.p50);
    assert.equal(second.regressions.length, 0);
  } finally {
    await manager.closeAll();
    await rm(directory, { recursive: true, force: true, maxRetries: 5 });
  }
});

test("性能场景拒绝不合法规格与环境不匹配的基线", { timeout: 60_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "tuilens-perf-invalid-"));
  const manager = new SessionManager({ artifactDir: directory });
  try {
    await assert.rejects(runPerf(manager, { spec: { version: 2 }, directory }), { code: "INVALID_PERF_SPEC" });
    await assert.rejects(
      runPerf(manager, { spec: { version: 1, launch: { command: "node" }, phases: [] }, directory }),
      { code: "INVALID_PERF_SPEC" }
    );
    const mismatch = join(directory, "mismatch.json");
    await (await import("node:fs/promises")).writeFile(
      mismatch,
      JSON.stringify({
        version: 1,
        createdAt: new Date().toISOString(),
        environment: { platform: "other", node: "v0", arch: "x", cols: 40, rows: 8 },
        metrics: [],
      })
    );
    await assert.rejects(
      runPerf(manager, {
        spec: {
          version: 1,
          launch: { command: process.execPath, args: fixture, cols: 40, rows: 8 },
          ready: [{ kind: "text", text: "TURN_0" }],
          rounds: 1,
          repeats: 1,
          phases: [
            {
              name: "add",
              samples: [{ input: { type: "text", text: "x" }, observe: [{ kind: "text", text: "TURN_1" }] }],
            },
          ],
        },
        directory,
        baseline: mismatch,
      }),
      { code: "PERF_ENVIRONMENT_MISMATCH" }
    );
  } finally {
    await manager.closeAll();
    await rm(directory, { recursive: true, force: true, maxRetries: 5 });
  }
});
