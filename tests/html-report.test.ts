import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { PNG } from "pngjs";
import { chromium } from "playwright-core";
import { resolveBrowserExecutable } from "../src/engine/browser-engine.js";
import type { PerfMatrixResult, PerfResult } from "../src/perf/runner.js";
import type { ScenarioMatrixResult, ScenarioResult } from "../src/scenario/runner.js";
import { buildPerfEvidence, buildScenarioEvidence, writeEvidenceBundle } from "../src/reporting/bundle.js";
import {
  MAX_SINGLE_INLINE_IMAGE_BYTES,
  renderPerfHtmlReport,
  renderRecordingHtmlReport,
  renderScenarioHtmlReport,
} from "../src/reporting/html-report.js";

const run = promisify(execFile);
const cli = fileURLToPath(new URL("../src/interfaces/cli.js", import.meta.url));
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
  "base64"
);

test("scenario HTML 报告包含时间轴、对比滑块、矩阵标签和转义", { timeout: 30000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "tuilens-html-scenario-"));
  try {
    const baseline = join(directory, "baseline.png");
    const actual = join(directory, "actual.png");
    const diff = join(directory, "diff.png");
    const failure = join(directory, "failure.png");
    await Promise.all([baseline, actual, diff, failure].map((path) => writeFile(path, png)));
    const scenario = scenarioResult(directory, {
      pass: false,
      failureScreenshot: failure,
      steps: [
        {
          index: 0,
          type: "wait",
          name: "ready",
          detail: 'wait text "READY"',
          elapsedMs: 12,
          result: { frameId: 2 },
        },
        {
          index: 1,
          type: "compare",
          name: "</script><img src=x onerror=alert(1)>",
          detail: "</script><img src=x onerror=alert(1)>",
          elapsedMs: 8,
          result: { pass: false, baseline, actual, diff, mismatchPixels: 9 },
        },
      ],
    });
    await writeFile(scenario.reportPath, JSON.stringify(scenario));
    const matrix: ScenarioMatrixResult = {
      pass: false,
      matrix: true,
      reportPath: scenario.reportPath,
      profiles: ["xterm-256color", "kitty"],
      runs: [scenario, { ...scenario, terminalProfile: "kitty" }],
    };
    const report = await renderScenarioHtmlReport(matrix, { generatedAt: "2026-01-01T00:00:00.000Z" });
    assert.equal(report.manifest.kind, "scenario-matrix");
    assert.equal(report.inlineImages, 4);
    assert.match(report.html, /data-compare=/u);
    assert.match(report.html, /\.compare-clip\{position:absolute;inset:0;/u);
    assert.match(report.html, /\.compare\{[^}]*width:fit-content/u);
    assert.match(report.html, /clip\.style\.clipPath = "inset\(0 0 0 " \+ \(100 - value\) \+ "%\)"/u);
    assert.doesNotMatch(report.html, /clip\.style\.right/u);
    assert.match(report.html, /Matrix summary/u);
    assert.match(report.html, /data-tab="scenario-run-1"/u);
    assert.match(report.html, /Difference image/u);
    assert.match(report.html, /&lt;\/script&gt;&lt;img/u);
    assert.doesNotMatch(report.html, /<\/script><img/u);
    assert.doesNotMatch(report.html, /<script[^>]+src=/u);
    assert.doesNotMatch(report.html, /<link[^>]+href=/u);
    assert.match(report.html, /application\/json" id="evidence-manifest"/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("HTML 报告按单图和总预算降级图片，不使报告失败", { timeout: 30000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "tuilens-html-budget-"));
  try {
    const one = join(directory, "one.png");
    const two = join(directory, "two.png");
    await writeFile(one, Buffer.alloc(40, 1));
    await writeFile(two, Buffer.alloc(40, 2));
    const scenario = scenarioResult(directory, {
      steps: [
        {
          index: 0,
          type: "observe",
          elapsedMs: 1,
          result: { path: one, width: 1, height: 1 },
        },
      ],
      failureScreenshot: two,
    });
    const total = await renderScenarioHtmlReport(scenario, {
      maxSingleImageBytes: 100,
      maxTotalImageBytes: 60,
    });
    assert.equal(total.inlineImages, 1);
    assert.match(total.html, /Not inlined: report image budget/u);

    const large = join(directory, "large.png");
    await writeFile(large, "");
    await truncate(large, MAX_SINGLE_INLINE_IMAGE_BYTES + 1);
    const tooLarge = await renderScenarioHtmlReport(scenarioResult(directory, { failureScreenshot: large }), {
      maxSingleImageBytes: 10,
    });
    assert.equal(tooLarge.inlineImages, 0);
    assert.match(tooLarge.html, /single-image limit/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("scenario HTML 对比滑块按固定几何裁剪，拖动不缩放且左侧为 Baseline", { timeout: 30000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "tuilens-html-compare-"));
  try {
    const baseline = join(directory, "baseline.png");
    const actual = join(directory, "actual.png");
    const diff = join(directory, "diff.png");
    await Promise.all([
      writeFile(baseline, solidPng(480, 300, [205, 45, 55])),
      writeFile(actual, solidPng(480, 300, [30, 95, 210])),
      writeFile(diff, solidPng(480, 300, [30, 95, 210])),
    ]);
    const scenario = scenarioResult(directory, {
      steps: [
        {
          index: 0,
          type: "compare",
          elapsedMs: 1,
          result: { pass: false, baseline, actual, diff, mismatchPixels: 9 },
        },
      ],
    });
    const report = await renderScenarioHtmlReport(scenario, { generatedAt: "2026-01-01T00:00:00.000Z" });
    const reportPath = join(directory, "report.html");
    await writeFile(reportPath, report.html);
    const executablePath = resolveBrowserExecutable();
    const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
    try {
      const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
      await page.goto(pathToFileURL(reportPath).href, { waitUntil: "load" });
      const sizes = await page.evaluate(() => {
        const root = document.querySelector("[data-compare]");
        const baselineImage = root?.querySelector(".compare-stage > img");
        const clip = root?.querySelector(".compare-clip");
        const actualImage = clip?.querySelector("img");
        const range = root?.querySelector("input[type=range]");
        if (
          !(baselineImage instanceof HTMLImageElement) ||
          !(clip instanceof HTMLElement) ||
          !(actualImage instanceof HTMLImageElement) ||
          !(range instanceof HTMLInputElement)
        ) {
          throw new Error("compare widget is incomplete");
        }
        return [20, 50, 80].map((value) => {
          range.value = String(value);
          range.dispatchEvent(new Event("input", { bubbles: true }));
          return {
            value,
            baselineWidth: baselineImage.getBoundingClientRect().width,
            actualWidth: actualImage.getBoundingClientRect().width,
            actualHeight: actualImage.getBoundingClientRect().height,
            clipPath: getComputedStyle(clip).clipPath,
          };
        });
      });
      for (const size of sizes) {
        assert.ok(Math.abs(size.actualWidth - size.baselineWidth) < 0.5, JSON.stringify(size));
        assert.ok(Math.abs(size.actualWidth - sizes[0]!.actualWidth) < 0.5, JSON.stringify(sizes));
        assert.match(size.clipPath, /inset/u);
      }
      await page.evaluate(() => {
        const range = document.querySelector("[data-compare] input[type=range]");
        if (!(range instanceof HTMLInputElement)) throw new Error("compare range is missing");
        range.value = "50";
        range.dispatchEvent(new Event("input", { bubbles: true }));
      });
      const stage = PNG.sync.read(await page.locator(".compare-stage").screenshot());
      const left = pixelAt(stage, 0.25, 0.5);
      const right = pixelAt(stage, 0.75, 0.5);
      assert.ok(left[0] > 150 && left[1] < 100 && left[2] < 100, JSON.stringify(left));
      assert.ok(right[2] > 150 && right[0] < 100, JSON.stringify(right));
    } finally {
      await browser.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("perf HTML 报告包含指标、SVG 图表、RSS 时间线和基线回归", { timeout: 30000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "tuilens-html-perf-"));
  try {
    const perf = perfResult(directory);
    await writeFile(perf.reportPath, JSON.stringify(perf));
    const matrix: PerfMatrixResult = {
      pass: true,
      matrix: true,
      reportPath: perf.reportPath,
      profiles: ["xterm-256color", "kitty"],
      table: [
        {
          phase: "short",
          name: "add-turn",
          values: [
            { profile: "xterm-256color", p50: 2.5, p95: 4, stability: "stable" },
            { profile: "kitty", p50: 3.5, p95: 5, stability: "noisy" },
          ],
        },
      ],
      runs: [perf, { ...perf, environment: { ...perf.environment, terminalProfile: "kitty" } }],
    };
    const report = await renderPerfHtmlReport(matrix, { generatedAt: "2026-01-01T00:00:00.000Z" });
    assert.equal(report.manifest.kind, "perf-matrix");
    assert.match(report.html, /Metric latency/u);
    assert.match(report.html, /<polyline/u);
    assert.match(report.html, /RSS timeline/u);
    assert.match(report.html, /Baseline comparison/u);
    assert.match(report.html, /regression/u);
    assert.match(report.html, /data-tab="perf-run-1"/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Evidence Bundle 目录复制并重定位所有 artifact，且 matrix 回归数正确汇总", { timeout: 30000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "tuilens-bundle-"));
  try {
    const report = join(directory, "scenario.json");
    const screenshot = join(directory, "shot.png");
    await Promise.all([writeFile(report, JSON.stringify({ ok: true })), writeFile(screenshot, png)]);
    const scenario = scenarioResult(directory, {
      reportPath: report,
      steps: [{ index: 0, type: "observe", elapsedMs: 1, result: { path: screenshot, width: 1, height: 1 } }],
    });
    const manifest = await buildScenarioEvidence(scenario, { generatedAt: "2026-01-01T00:00:00.000Z" });
    const bundleDir = join(directory, "bundle");
    const written = await writeEvidenceBundle(manifest, scenario, bundleDir);
    assert.equal(written.manifest.payloadPath, "payload.json");
    assert.equal(written.manifest.artifacts.find((artifact) => artifact.role === "report")?.path, "payload.json");
    for (const artifact of written.manifest.artifacts) {
      assert.ok((await readFile(join(bundleDir, artifact.path))).length > 0);
    }

    const first = perfResult(directory);
    const second = { ...first, regressions: ["second regression"] };
    const matrix: PerfMatrixResult = {
      pass: false,
      matrix: true,
      reportPath: first.reportPath,
      profiles: ["xterm-256color", "kitty"],
      table: [],
      runs: [first, second],
    };
    const perfManifest = await buildPerfEvidence(matrix);
    assert.equal(perfManifest.summary.regressions, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("recording HTML 报告解析 header、resize、exit 与 truncated", { timeout: 30000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "tuilens-html-recording-"));
  try {
    const path = join(directory, "sample.recording.jsonl");
    const lines = [
      {
        type: "header",
        version: 2,
        cols: 80,
        rows: 24,
        renderer: "headless",
        profile: { name: "xterm-256color" },
      },
      { type: "output", data: "\u001b[32mHELLO\u001b[0m\n", atMs: 10 },
      { type: "resize", cols: 100, rows: 30, atMs: 20 },
      { type: "exit", code: 7, atMs: 30 },
      { type: "end", truncated: true, atMs: 30 },
    ];
    await writeFile(path, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
    const report = await renderRecordingHtmlReport(path, { generatedAt: "2026-01-01T00:00:00.000Z" });
    assert.equal(report.manifest.kind, "recording");
    assert.match(report.html, /recording-data/u);
    assert.match(report.html, /recording-screen/u);
    assert.match(report.html, /truncated/u);
    assert.match(report.html, /100 x 30/u);
    assert.match(report.html, /code 7/u);
    assert.match(report.html, /xterm-256color/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("scenario --html、perf --html 与 report 端到端生成单文件报告", { timeout: 90000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), "tuilens-html-e2e-"));
  const env = { ...process.env, TUILENS_HOME: home, TUILENS_LANG: "en" };
  try {
    const scenarioSpec = join(home, "scenario.json");
    const scenarioHtml = join(home, "scenario.html");
    await writeFile(
      scenarioSpec,
      JSON.stringify({
        version: 1,
        launch: {
          command: process.execPath,
          args: [join(process.cwd(), "examples", "echo-tui.mjs")],
          cols: 80,
          rows: 16,
        },
        steps: [
          { type: "wait", conditions: [{ kind: "text", text: "READY" }] },
          { type: "input", action: { type: "key", key: "Ctrl+q" } },
          { type: "wait", conditions: [{ kind: "exited" }] },
        ],
      })
    );
    const scenarioRun = await run(process.execPath, [cli, "scenario", "--file", scenarioSpec, "--html", scenarioHtml], {
      env,
      maxBuffer: 20 * 1024 * 1024,
    });
    const scenarioPayload = JSON.parse(scenarioRun.stdout) as {
      ok: boolean;
      data: { reportPath: string };
    };
    assert.equal(scenarioPayload.ok, true);
    assert.match(await readFile(scenarioHtml, "utf8"), /TuiLens scenario evidence/u);
    const offline = join(home, "offline.html");
    await run(process.execPath, [cli, "report", scenarioPayload.data.reportPath, "--out", offline], {
      env,
      maxBuffer: 20 * 1024 * 1024,
    });
    assert.match(await readFile(offline, "utf8"), /scenario/u);

    const perfSpec = join(home, "perf.json");
    const perfHtml = join(home, "perf.html");
    await writeFile(
      perfSpec,
      JSON.stringify({
        version: 1,
        launch: {
          command: process.execPath,
          args: [join(process.cwd(), "examples", "perf-tui.mjs")],
          cols: 80,
          rows: 24,
        },
        ready: [{ kind: "text", text: "TURN_0" }],
        warmupRounds: 0,
        rounds: 1,
        repeats: 1,
        phases: [
          {
            name: "short",
            samples: [
              {
                name: "add-turn",
                input: { type: "text", text: "x" },
                observe: [{ kind: "text", text: "TURN_{{seq}}" }],
                timeoutMs: 10000,
              },
            ],
          },
        ],
      })
    );
    const perfRun = await run(process.execPath, [cli, "perf", "--file", perfSpec, "--html", perfHtml], {
      env,
      maxBuffer: 20 * 1024 * 1024,
    });
    const perfPayload = JSON.parse(perfRun.stdout) as { ok: boolean };
    assert.equal(perfPayload.ok, true);
    assert.match(await readFile(perfHtml, "utf8"), /TuiLens performance evidence/u);
  } finally {
    await run(process.execPath, [cli, "shutdown"], { env, maxBuffer: 1024 * 1024 }).catch(() => undefined);
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

function scenarioResult(directory: string, overrides: Partial<ScenarioResult> = {}): ScenarioResult {
  return {
    pass: true,
    reportPath: join(directory, "scenario.json"),
    cols: 80,
    rows: 24,
    terminalProfile: "xterm-256color",
    renderer: "headless",
    steps: [{ index: 0, type: "wait", name: "ready", detail: 'wait text "READY"', elapsedMs: 3 }],
    ...overrides,
  };
}

function solidPng(width: number, height: number, color: [number, number, number]): Buffer {
  const png = new PNG({ width, height });
  for (let offset = 0; offset < png.data.length; offset += 4) png.data.set([...color, 255], offset);
  return PNG.sync.write(png);
}

function pixelAt(image: PNG, xRatio: number, yRatio: number): [number, number, number] {
  const x = Math.floor(image.width * xRatio);
  const y = Math.floor(image.height * yRatio);
  const offset = (y * image.width + x) * 4;
  return [image.data[offset]!, image.data[offset + 1]!, image.data[offset + 2]!];
}

function perfResult(directory: string): PerfResult {
  const summary = { count: 3, min: 1, p50: 2.5, p95: 4, p99: 4.5, max: 5, mean: 2.8 };
  return {
    pass: false,
    reportPath: join(directory, "perf.json"),
    environment: {
      platform: "linux",
      node: "v22.0.0",
      arch: "x64",
      cols: 80,
      rows: 24,
      terminalProfile: "xterm-256color",
      renderer: "headless",
    },
    settings: { rounds: 1, repeats: 1, warmupRounds: 0, maxRegression: 0.15 },
    metrics: [
      {
        phase: "short",
        name: "add-turn",
        elapsedMs: summary,
        samples: 3,
        stability: { spread: 2, verdict: "noisy" },
      },
    ],
    warmupStartupMs: null,
    processTree: {
      peakRssBytes: 2048,
      peakRootRssBytes: 1024,
      peakProcesses: 2,
      samples: 2,
      errors: 0,
      intervalMs: 1000,
      approximate: true,
      timeline: [
        { round: 1, atMs: 0, rssBytes: 1000, rootRssBytes: 500, processes: 1 },
        { round: 1, atMs: 1000, rssBytes: 2000, rootRssBytes: 1000, processes: 2 },
      ],
    },
    rounds: [
      {
        round: 1,
        startupMs: 20,
        metrics: [
          {
            phase: "short",
            name: "add-turn",
            elapsedMs: summary,
            samples: 3,
          },
        ],
        session: { receivedBytes: 10, appliedBytes: 10, writeBatches: 1 },
      },
    ],
    comparisons: [
      {
        phase: "short",
        name: "add-turn",
        baselineP50: 1,
        currentP50: 2.5,
        changeRatio: 1.5,
        baselineP95: 2,
        currentP95: 4,
        regression: true,
      },
    ],
    regressions: ["short/add-turn: regression"],
    errors: [],
  };
}
