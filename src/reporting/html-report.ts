import { mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { readBoundedFile } from "../core/bounded-file.js";
import { TuiLensError } from "../core/errors.js";
import type { MetricSummary, PerfMatrixResult, PerfMatrixRun, PerfResult, PerfRssPoint } from "../perf/runner.js";
import type { ScenarioMatrixResult, ScenarioResult, ScenarioRunResult } from "../scenario/runner.js";
import {
  buildPerfEvidence,
  buildRecordingEvidence,
  buildScenarioEvidence,
  isPerfMatrixResult,
  isScenarioMatrixResult,
  mimeTypeForPath,
  readRecordingReport,
  type EvidenceArtifact,
  type EvidenceArtifactRole,
  type EvidenceManifest,
  type RecordingReport,
  type RecordingReportEvent,
} from "./bundle.js";

export const MAX_SINGLE_INLINE_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_INLINE_IMAGE_BYTES = 24 * 1024 * 1024;
export const MAX_RECORDING_REPORT_TEXT_BYTES = 2 * 1024 * 1024;

export interface HtmlReportOptions {
  generatedAt?: string;
  maxSingleImageBytes?: number;
  maxTotalImageBytes?: number;
  maxRecordingTextBytes?: number;
}

export interface HtmlReportResult {
  html: string;
  manifest: EvidenceManifest;
  inlineImages: number;
  inlineImageBytes: number;
}

interface ImageAsset {
  path: string;
  bytes?: number;
  dataUri?: string;
  note?: string;
}

class ImageLoader {
  private readonly cache = new Map<string, ImageAsset>();
  private readonly pending = new Map<string, Promise<ImageAsset>>();
  private inlineImages = 0;
  private inlineImageBytes = 0;
  private readonly maxSingle: number;
  private readonly maxTotal: number;

  constructor(options: HtmlReportOptions) {
    this.maxSingle = Math.max(1, options.maxSingleImageBytes ?? MAX_SINGLE_INLINE_IMAGE_BYTES);
    this.maxTotal = Math.max(1, options.maxTotalImageBytes ?? MAX_INLINE_IMAGE_BYTES);
  }

  async get(path: string): Promise<ImageAsset> {
    const target = resolve(path);
    const cached = this.cache.get(target);
    if (cached) return cached;
    const active = this.pending.get(target);
    if (active) return active;
    const task = this.load(target);
    this.pending.set(target, task);
    try {
      return await task;
    } finally {
      this.pending.delete(target);
    }
  }

  private async load(target: string): Promise<ImageAsset> {
    const info = await stat(target).catch(() => null);
    const bytes = info?.isFile() ? info.size : undefined;
    let asset: ImageAsset;
    try {
      const data = await readBoundedFile(target, this.maxSingle);
      if (this.inlineImageBytes + data.length > this.maxTotal) {
        asset = {
          path: target,
          ...(bytes === undefined ? {} : { bytes }),
          note: `Not inlined: report image budget is ${formatBytes(this.maxTotal)}.`,
        };
      } else {
        this.inlineImageBytes += data.length;
        this.inlineImages += 1;
        asset = {
          path: target,
          ...(bytes === undefined ? {} : { bytes }),
          dataUri: `data:${mimeTypeForPath(target)};base64,${data.toString("base64")}`,
        };
      }
    } catch (error) {
      asset = {
        path: target,
        ...(bytes === undefined ? {} : { bytes }),
        note:
          bytes !== undefined && bytes > this.maxSingle
            ? `Not inlined: ${formatBytes(bytes)} exceeds the ${formatBytes(this.maxSingle)} single-image limit.`
            : `Not inlined: ${errorText(error)}`,
      };
    }
    this.cache.set(target, asset);
    return asset;
  }

  result(): Pick<HtmlReportResult, "inlineImages" | "inlineImageBytes"> {
    return { inlineImages: this.inlineImages, inlineImageBytes: this.inlineImageBytes };
  }
}

export async function renderScenarioHtmlReport(
  result: ScenarioRunResult,
  options: HtmlReportOptions = {}
): Promise<HtmlReportResult> {
  const manifest = await buildScenarioEvidence(result, {
    ...(options.generatedAt === undefined ? {} : { generatedAt: options.generatedAt }),
  });
  const images = new ImageLoader(options);
  const matrix = isScenarioMatrixResult(result);
  const runs = matrix ? result.runs : [result];
  const summary = scenarioSummary(result, runs);
  const tabs =
    matrix && runs.length > 1
      ? `<div class="tabs" role="tablist">${runs
          .map(
            (run, index) =>
              `<button type="button" class="tab${index === 0 ? " active" : ""}" data-tab="scenario-run-${index}" role="tab" aria-selected="${index === 0}">${escapeHtml(run.terminalProfile ?? `profile ${index + 1}`)}</button>`
          )
          .join("")}</div>`
      : "";
  const sections = await Promise.all(
    runs.map(async (run, index) => {
      const content = await scenarioRunSection(run, index, manifest, images);
      if (!matrix || runs.length === 1) return content;
      return `<section id="scenario-run-${index}" class="tab-panel${index === 0 ? " active" : ""}" role="tabpanel">${content}</section>`;
    })
  );
  const body = [
    summaryCards(summary),
    matrix ? scenarioMatrixTable(runs) : "",
    tabs + `<div class="tab-panels">${sections.join("")}</div>`,
  ].join("");
  return {
    html: shell("TuiLens scenario evidence", manifest, body),
    manifest,
    ...images.result(),
  };
}

export async function renderPerfHtmlReport(
  result: PerfMatrixResult | PerfResult,
  options: HtmlReportOptions = {}
): Promise<HtmlReportResult> {
  const manifest = await buildPerfEvidence(result, {
    ...(options.generatedAt === undefined ? {} : { generatedAt: options.generatedAt }),
  });
  const images = new ImageLoader(options);
  const matrix = isPerfMatrixResult(result);
  const runs: PerfMatrixRun[] = matrix ? result.runs : [result];
  const successes = runs.filter((run): run is PerfResult => run.reportPath !== null);
  const summary = perfSummary(result, runs);
  const tabs =
    matrix && runs.length > 1
      ? `<div class="tabs" role="tablist">${runs
          .map((run, index) => {
            const label =
              run.reportPath === null ? run.profile : (run.environment.terminalProfile ?? `profile ${index + 1}`);
            return `<button type="button" class="tab${index === 0 ? " active" : ""}" data-tab="perf-run-${index}" role="tab" aria-selected="${index === 0}">${escapeHtml(label)}</button>`;
          })
          .join("")}</div>`
      : "";
  const sections = runs.map((run, index) => {
    const content = perfRunSection(run, index);
    if (!matrix || runs.length === 1) return content;
    return `<section id="perf-run-${index}" class="tab-panel${index === 0 ? " active" : ""}" role="tabpanel">${content}</section>`;
  });
  const body = [
    summaryCards(summary),
    matrix ? perfMatrixTable(result, successes) : "",
    tabs + `<div class="tab-panels">${sections.join("")}</div>`,
  ].join("");
  return {
    html: shell("TuiLens performance evidence", manifest, body),
    manifest,
    ...images.result(),
  };
}

export async function renderRecordingHtmlReport(
  recordingPath: string,
  options: HtmlReportOptions = {}
): Promise<HtmlReportResult> {
  const recording = await readRecordingReport(recordingPath);
  const manifest = buildRecordingEvidence(recording, {
    ...(options.generatedAt === undefined ? {} : { generatedAt: options.generatedAt }),
  });
  const maxText = Math.max(1024, options.maxRecordingTextBytes ?? MAX_RECORDING_REPORT_TEXT_BYTES);
  const timeline = recordingTimeline(recording.events, maxText);
  const body = [
    `${recording.truncated ? `<div class="warning">This recording is truncated or has no complete end marker. The report shows the available events.</div>` : ""}`,
    summaryCards([
      [
        "Status",
        recording.complete && !recording.truncated ? "complete" : "truncated",
        recording.truncated ? "bad" : "good",
      ],
      ["Events", String(recording.events.length), "neutral"],
      ["Duration", formatDuration(recording.durationMs), "neutral"],
      [
        "Exit",
        recording.exitCode === undefined ? "none" : String(recording.exitCode),
        recording.exitCode === 0 ? "good" : "warn",
      ],
    ]),
    `<section class="card"><h2>Recording header</h2>${keyValue([
      ["Grid", `${recording.header.cols} x ${recording.header.rows}`],
      ["Renderer", recording.header.renderer],
      ["Terminal profile", recording.header.terminalProfile ?? "default"],
      ["Source", recording.path],
    ])}</section>`,
    `<section class="card"><h2>Offline timeline</h2>
      <p class="muted">Drag the timeline to reveal output up to that point. ANSI control sequences are stripped; recorded input is never executed.</p>
      <input id="recording-range" class="recording-range" type="range" min="0" max="${Math.max(1, recording.durationMs)}" value="${Math.max(1, recording.durationMs)}" />
      <div class="timeline-time"><span id="recording-time">${formatDuration(recording.durationMs)}</span><span>${recording.truncated ? "truncated" : "complete"}</span></div>
      <pre id="recording-screen" class="recording-screen" aria-live="polite"></pre>
    </section>`,
    `<section class="card"><h2>Resize and lifecycle events</h2>${recordingLifecycle(recording.events)}</section>`,
    `<section class="card"><h2>Event inventory</h2>${recordingEventsTable(recording.events, timeline.events.length)}</section>`,
  ].join("");
  return {
    html: shell("TuiLens recording evidence", manifest, body, {
      id: "recording-data",
      value: {
        durationMs: recording.durationMs,
        events: timeline.events,
        truncated: timeline.truncated,
      },
    }),
    manifest,
    inlineImages: 0,
    inlineImageBytes: 0,
  };
}

export async function renderEvidenceFileHtmlReport(
  inputPath: string,
  options: HtmlReportOptions = {}
): Promise<HtmlReportResult> {
  const extension = extname(inputPath).toLowerCase();
  if (extension === ".jsonl" || extension === ".ndjson") return renderRecordingHtmlReport(inputPath, options);
  const text = (await readBoundedFile(inputPath, 64 * 1024 * 1024)).toString("utf8");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new TuiLensError(
      "INVALID_ARGUMENT",
      "报告输入不是有效 JSON；录制请使用 .jsonl",
      undefined,
      "Report input is not valid JSON; use .jsonl for recordings."
    );
  }
  if (isScenarioResult(value)) return renderScenarioHtmlReport(value, options);
  if (isPerfResult(value)) return renderPerfHtmlReport(value, options);
  throw new TuiLensError(
    "INVALID_ARGUMENT",
    "无法从 JSON 识别 scenario 或 perf 报告",
    undefined,
    "The JSON file is not a recognized scenario or perf report."
  );
}

export async function writeHtmlReport(path: string, report: HtmlReportResult): Promise<void> {
  const target = resolve(path);
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  await writeFile(target, report.html, { mode: 0o644 });
}

async function scenarioRunSection(
  run: ScenarioResult,
  index: number,
  manifest: EvidenceManifest,
  images: ImageLoader
): Promise<string> {
  const steps: string[] = [];
  for (const step of run.steps) {
    const failed = step.error !== undefined;
    const screenshot = findArtifact(manifest, "screenshot", step.index, run.terminalProfile);
    const compare = compareArtifacts(manifest, step.index, run.terminalProfile);
    const result = asRecord(step.result);
    const extra: string[] = [];
    if (screenshot) extra.push(await imageFigure(screenshot, images, `Step ${step.index + 1} screenshot`));
    if (compare) extra.push(await compareWidget(`compare-${index}-${step.index}`, compare, images));
    if (!screenshot && !compare && result) {
      extra.push(
        `<details><summary>Result JSON</summary><pre>${escapeHtml(boundedJson(result, 6000))}</pre></details>`
      );
    }
    steps.push(
      `<li class="timeline-item ${failed ? "fail" : "pass"}">
        <div class="timeline-dot"></div>
        <div class="timeline-content">
          <div class="row-between"><strong>${step.index + 1}. ${escapeHtml(step.type)}${step.name ? ` · ${escapeHtml(step.name)}` : ""}</strong><span class="badge ${failed ? "bad" : "good"}">${failed ? "failed" : "passed"}</span></div>
          ${step.detail ? `<div class="step-detail">${escapeHtml(step.detail)}</div>` : ""}
          <div class="muted">${formatDuration(step.elapsedMs)}</div>
          ${step.error === undefined ? "" : `<pre class="error">${escapeHtml(boundedJson(step.error, 6000))}</pre>`}
          ${extra.join("")}
        </div>
      </li>`
    );
  }
  const failure = findArtifact(manifest, "failure-screenshot", undefined, run.terminalProfile);
  return `<section class="card run-section">
    <div class="row-between"><h2>${escapeHtml(run.terminalProfile ?? `Run ${index + 1}`)}</h2><span class="badge ${run.pass ? "good" : "bad"}">${run.pass ? "passed" : "failed"}</span></div>
    ${keyValue([
      ["Renderer", run.renderer ?? "unknown"],
      ["Grid", run.cols === undefined || run.rows === undefined ? "unknown" : `${run.cols} x ${run.rows}`],
      ["Steps", String(run.steps.length)],
      ["Total time", formatDuration(run.steps.reduce((sum, step) => sum + step.elapsedMs, 0))],
      ["Report", run.reportPath],
    ])}
    ${run.cleanupError === undefined ? "" : `<div class="warning">Cleanup error: ${escapeHtml(boundedJson(run.cleanupError, 3000))}</div>`}
    <ol class="timeline">${steps.join("")}</ol>
    ${failure ? `<h3>Failure evidence</h3>${await imageFigure(failure, images, "Failure screenshot")}` : ""}
  </section>`;
}

function perfRunSection(run: PerfMatrixRun, index: number): string {
  if (run.reportPath === null) {
    return `<section class="card run-section"><div class="row-between"><h2>${escapeHtml(run.profile)}</h2><span class="badge bad">failed</span></div><pre class="error">${escapeHtml(boundedJson(run.error, 6000))}</pre></section>`;
  }
  const first = run.metrics[0];
  const startup = run.rounds.length
    ? run.rounds.reduce((sum, round) => sum + round.startupMs, 0) / run.rounds.length
    : 0;
  return `<section class="card run-section">
    <div class="row-between"><h2>${escapeHtml(run.environment.terminalProfile ?? `Run ${index + 1}`)}</h2><span class="badge ${run.pass ? "good" : "bad"}">${run.pass ? "passed" : "failed"}</span></div>
    ${keyValue([
      ["Renderer", run.environment.renderer ?? "unknown"],
      ["Grid", `${run.environment.cols} x ${run.environment.rows}`],
      ["Rounds", `${run.settings.rounds} (+${run.settings.warmupRounds} warmup)`],
      ["Report", run.reportPath],
    ])}
    ${summaryCards([
      ["p50", first ? `${first.elapsedMs.p50} ms` : "n/a", "neutral"],
      ["p95", first ? `${first.elapsedMs.p95} ms` : "n/a", "neutral"],
      ["p99", first ? `${first.elapsedMs.p99} ms` : "n/a", "neutral"],
      ["Stability", first?.stability.verdict ?? "n/a", first?.stability.verdict === "stable" ? "good" : "warn"],
      ["Startup", `${round(startup, 1)} ms`, "neutral"],
      ["Peak RSS", formatBytes(run.processTree.peakRssBytes), "neutral"],
      ["Peak root RSS", formatBytes(run.processTree.peakRootRssBytes), "neutral"],
    ])}
    <h3>Metric latency</h3>
    ${perfMetricsTable(run.metrics)}
    ${metricBarChart(run.metrics)}
    <p class="muted">SVG bars show p50; the thin overlay marks p95. Startup card is the average across measured rounds.</p>
    <h3>RSS timeline</h3>
    ${rssTimelineChart(run.processTree.timeline ?? [])}
    <p class="muted">Sampling interval ${run.processTree.intervalMs} ms; peaks are lower bounds. Timeline is capped at 512 points.</p>
    ${run.comparisons.length ? `<h3>Baseline comparison</h3>${comparisonTable(run.comparisons)}` : ""}
    ${run.regressions.length ? `<div class="warning"><strong>Regressions</strong><ul>${run.regressions.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul></div>` : ""}
    ${run.errors.length ? `<details class="error-details"><summary>${run.errors.length} round error(s)</summary><pre class="error">${escapeHtml(boundedJson(run.errors, 8000))}</pre></details>` : ""}
  </section>`;
}

function scenarioSummary(result: ScenarioRunResult, runs: ScenarioResult[]): [string, string, Tone][] {
  const steps = runs.reduce((sum, run) => sum + run.steps.length, 0);
  const failures = runs.filter((run) => !run.pass).length;
  return [
    ["Status", result.pass ? "passed" : "failed", result.pass ? "good" : "bad"],
    ["Runs", String(runs.length), "neutral"],
    ["Steps", String(steps), "neutral"],
    ["Failures", String(failures), failures ? "bad" : "good"],
  ];
}

function perfSummary(result: PerfMatrixResult | PerfResult, runs: PerfMatrixRun[]): [string, string, Tone][] {
  const successes = runs.filter((run): run is PerfResult => run.reportPath !== null);
  return [
    ["Status", result.pass ? "passed" : "failed", result.pass ? "good" : "bad"],
    ["Runs", String(runs.length), "neutral"],
    ["Metrics", String(successes.reduce((sum, run) => sum + run.metrics.length, 0)), "neutral"],
    ["Regressions", String(successes.reduce((sum, run) => sum + run.regressions.length, 0)), "warn"],
  ];
}

function summaryCards(items: [string, string, Tone][]): string {
  return `<section class="summary">${items
    .map(
      ([label, value, tone]) =>
        `<div class="metric ${tone}"><div class="metric-label">${escapeHtml(label)}</div><div class="metric-value">${escapeHtml(value)}</div></div>`
    )
    .join("")}</section>`;
}

function scenarioMatrixTable(runs: ScenarioResult[]): string {
  return `<section class="card"><h2>Matrix summary</h2><div class="table-wrap"><table><thead><tr><th>Profile</th><th>Status</th><th>Steps</th><th>Duration</th><th>Report</th></tr></thead><tbody>${runs
    .map(
      (run) =>
        `<tr><td>${escapeHtml(run.terminalProfile ?? "default")}</td><td><span class="badge ${run.pass ? "good" : "bad"}">${run.pass ? "passed" : "failed"}</span></td><td>${run.steps.length}</td><td>${formatDuration(run.steps.reduce((sum, step) => sum + step.elapsedMs, 0))}</td><td class="mono">${escapeHtml(run.reportPath)}</td></tr>`
    )
    .join("")}</tbody></table></div></section>`;
}

function perfMatrixTable(result: PerfMatrixResult, successes: PerfResult[]): string {
  const profiles = result.profiles;
  const failureRows = result.runs
    .filter((run): run is PerfMatrixFailureLike => run.reportPath === null)
    .map((run) => `<tr><td>—</td><td>${escapeHtml(run.profile)}</td>${profiles.map(() => "<td>—</td>").join("")}</tr>`);
  const rows = result.table.map((row) => {
    const values = profiles.map((profile) => {
      const value = row.values.find((item) => item.profile === profile);
      return value
        ? `<td>${value.p50} / ${value.p95} ms <span class="badge ${value.stability === "stable" ? "good" : "warn"}">${value.stability}</span></td>`
        : "<td>—</td>";
    });
    return `<tr><td>${escapeHtml(row.phase)}</td><td>${escapeHtml(row.name)}</td>${values.join("")}</tr>`;
  });
  return `<section class="card"><h2>Profile comparison</h2><div class="table-wrap"><table><thead><tr><th>Phase</th><th>Metric</th>${profiles.map((profile) => `<th>${escapeHtml(profile)}</th>`).join("")}</tr></thead><tbody>${rows.join("")}${failureRows.join("")}</tbody></table></div><p class="muted">Cells show p50 / p95. ${successes.length} profile run(s) produced metrics.</p></section>`;
}

function perfMetricsTable(metrics: MetricSummary[]): string {
  if (!metrics.length) return `<div class="empty">No metrics were recorded.</div>`;
  return `<div class="table-wrap"><table><thead><tr><th>Phase</th><th>Metric</th><th>Samples</th><th>p50</th><th>p95</th><th>p99</th><th>Max</th></tr></thead><tbody>${metrics
    .map(
      (metric) =>
        `<tr><td>${escapeHtml(metric.phase)}</td><td>${escapeHtml(metric.name)}</td><td>${metric.samples}</td><td>${metric.elapsedMs.p50} ms</td><td>${metric.elapsedMs.p95} ms</td><td>${metric.elapsedMs.p99} ms</td><td>${metric.elapsedMs.max} ms</td></tr>`
    )
    .join("")}</tbody></table></div>`;
}

function comparisonTable(comparisons: PerfResult["comparisons"]): string {
  return `<div class="table-wrap"><table><thead><tr><th>Phase</th><th>Metric</th><th>Baseline p50</th><th>Current p50</th><th>Change</th><th>Status</th></tr></thead><tbody>${comparisons
    .map(
      (item) =>
        `<tr class="${item.regression ? "regression" : ""}"><td>${escapeHtml(item.phase)}</td><td>${escapeHtml(item.name)}</td><td>${item.baselineP50} ms</td><td>${item.currentP50} ms</td><td>${round(item.changeRatio * 100, 1)}%</td><td><span class="badge ${item.regression ? "bad" : "good"}">${item.regression ? "regression" : "ok"}</span></td></tr>`
    )
    .join("")}</tbody></table></div>`;
}

function metricBarChart(metrics: MetricSummary[]): string {
  const visible = metrics.slice(0, 24);
  if (!visible.length) return `<div class="empty">No latency chart data.</div>`;
  const width = 920;
  const rowHeight = 28;
  const labelWidth = 235;
  const chartWidth = 590;
  const height = visible.length * rowHeight + 28;
  const max = Math.max(1, ...visible.flatMap((metric) => [metric.elapsedMs.p50, metric.elapsedMs.p95]));
  const bars = visible.map((metric, index) => {
    const y = index * rowHeight + 12;
    const p50Width = (metric.elapsedMs.p50 / max) * chartWidth;
    const p95X = (metric.elapsedMs.p95 / max) * chartWidth;
    return `<g><title>${escapeHtml(`${metric.phase}/${metric.name}: p50 ${metric.elapsedMs.p50} ms, p95 ${metric.elapsedMs.p95} ms`)}</title><text x="0" y="${y + 13}" class="chart-label">${escapeHtml(truncate(`${metric.phase}/${metric.name}`, 30))}</text><rect x="${labelWidth}" y="${y}" width="${Math.max(1, p50Width)}" height="18" rx="3" class="chart-bar"></rect><line x1="${labelWidth + p95X}" y1="${y - 2}" x2="${labelWidth + p95X}" y2="${y + 20}" class="chart-p95"></line></g>`;
  });
  return `<div class="chart-wrap"><svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Latency by metric">${bars.join("")}</svg></div>`;
}

function rssTimelineChart(timeline: PerfRssPoint[]): string {
  if (timeline.length < 2) return `<div class="empty">Not enough RSS samples for a timeline.</div>`;
  const width = 920;
  const height = 240;
  const pad = 28;
  const elapsed: number[] = [];
  let offset = 0;
  let previousRound = timeline[0]!.round;
  let previousAt = 0;
  for (const point of timeline) {
    if (point.round !== previousRound) {
      offset += previousAt;
      previousRound = point.round;
    }
    previousAt = point.atMs;
    elapsed.push(offset + point.atMs);
  }
  const maxTime = Math.max(1, elapsed.at(-1) ?? 1);
  const maxRss = Math.max(1, ...timeline.map((point) => Math.max(point.rssBytes, point.rootRssBytes)));
  const points = (key: "rssBytes" | "rootRssBytes"): string =>
    timeline
      .map((point, index) => {
        const x = pad + ((elapsed[index] ?? 0) / maxTime) * (width - pad * 2);
        const y = height - pad - (point[key] / maxRss) * (height - pad * 2);
        return `${round(x, 1)},${round(y, 1)}`;
      })
      .join(" ");
  return `<div class="chart-wrap"><svg viewBox="0 0 ${width} ${height}" role="img" aria-label="RSS timeline"><line x1="${pad}" y1="${height - pad}" x2="${width - pad}" y2="${height - pad}" class="axis"></line><line x1="${pad}" y1="${pad}" x2="${pad}" y2="${height - pad}" class="axis"></line><polyline points="${points("rssBytes")}" class="rss-total"></polyline><polyline points="${points("rootRssBytes")}" class="rss-root"></polyline><text x="${pad}" y="18" class="chart-label">peak ${formatBytes(maxRss)}</text><text x="${pad}" y="${height - 5}" class="chart-label">0 ms</text><text x="${width - 120}" y="${height - 5}" class="chart-label">${formatDuration(maxTime)}</text></svg><div class="legend"><span><i class="swatch total"></i>tree RSS</span><span><i class="swatch root"></i>root RSS</span></div></div>`;
}

async function compareWidget(
  id: string,
  artifacts: { baseline: EvidenceArtifact; actual: EvidenceArtifact; diff: EvidenceArtifact },
  images: ImageLoader
): Promise<string> {
  const [baseline, actual, diff] = await Promise.all([
    images.get(artifacts.baseline.path),
    images.get(artifacts.actual.path),
    images.get(artifacts.diff.path),
  ]);
  if (!baseline.dataUri || !actual.dataUri) {
    return `<div class="compare-fallback">${await imageFigure(artifacts.baseline, images, "Baseline")}${await imageFigure(artifacts.actual, images, "Actual")}${await imageFigure(artifacts.diff, images, "Diff")}</div>`;
  }
  return `<div class="compare" data-compare="${escapeHtml(id)}"><div class="compare-stage"><img src="${baseline.dataUri}" alt="Baseline"><div class="compare-clip"><img src="${actual.dataUri}" alt="Actual"></div><div class="compare-divider"></div></div><input class="compare-range" type="range" min="0" max="100" value="50" aria-label="Compare baseline and actual screenshot"><div class="compare-labels"><span>Baseline</span><span>Actual</span></div></div>${diff.dataUri ? `<figure class="image-figure"><img src="${diff.dataUri}" alt="Diff"><figcaption>Difference image</figcaption></figure>` : await imageFigure(artifacts.diff, images, "Diff")}`;
}

async function imageFigure(artifact: EvidenceArtifact, images: ImageLoader, caption: string): Promise<string> {
  const asset = await images.get(artifact.path);
  if (asset.dataUri) {
    return `<figure class="image-figure"><img src="${asset.dataUri}" alt="${escapeHtml(caption)}"><figcaption>${escapeHtml(caption)} · ${formatBytes(asset.bytes)} · <span class="mono">${escapeHtml(artifact.path)}</span></figcaption></figure>`;
  }
  return `<div class="asset-missing"><strong>${escapeHtml(caption)}</strong><div>${escapeHtml(asset.note ?? "Image was not inlined.")}</div><div class="mono">${escapeHtml(artifact.path)}</div><div class="muted">${formatBytes(asset.bytes)}</div></div>`;
}

function findArtifact(
  manifest: EvidenceManifest,
  role: EvidenceArtifactRole,
  stepIndex?: number,
  profile?: string
): EvidenceArtifact | undefined {
  return manifest.artifacts.find(
    (artifact) =>
      artifact.role === role &&
      (stepIndex === undefined || artifact.stepIndex === stepIndex) &&
      (profile === undefined || artifact.profile === undefined || artifact.profile === profile)
  );
}

function compareArtifacts(
  manifest: EvidenceManifest,
  stepIndex: number,
  profile?: string
): { baseline: EvidenceArtifact; actual: EvidenceArtifact; diff: EvidenceArtifact } | undefined {
  const baseline = findArtifact(manifest, "compare-baseline", stepIndex, profile);
  const actual = findArtifact(manifest, "compare-actual", stepIndex, profile);
  const diff = findArtifact(manifest, "compare-diff", stepIndex, profile);
  return baseline && actual && diff ? { baseline, actual, diff } : undefined;
}

function recordingTimeline(
  events: RecordingReportEvent[],
  maxTextBytes: number
): { events: RecordingReportEvent[]; truncated: boolean } {
  const selected: RecordingReportEvent[] = [];
  let used = 0;
  let truncated = false;
  for (const event of events) {
    if (event.type === "output") {
      if (used >= maxTextBytes) {
        truncated = true;
        continue;
      }
      const remaining = maxTextBytes - used;
      const data = clipUtf8(event.data, remaining);
      used += Buffer.byteLength(data);
      selected.push({ type: "output", atMs: event.atMs, data });
      if (data.length < event.data.length) truncated = true;
    } else if (event.type === "resize" || event.type === "exit") {
      selected.push(event);
    }
  }
  return { events: selected, truncated };
}

function clipUtf8(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text) <= maxBytes) return text;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.floor((low + high + 1) / 2);
    if (Buffer.byteLength(text.slice(0, middle)) <= maxBytes) low = middle;
    else high = middle - 1;
  }
  return text.slice(0, low);
}

function recordingLifecycle(events: RecordingReportEvent[]): string {
  const lifecycle = events.filter((event) => event.type === "resize" || event.type === "exit").slice(0, 200);
  if (!lifecycle.length) return `<div class="empty">No resize or exit events.</div>`;
  return `<div class="table-wrap"><table><thead><tr><th>Time</th><th>Event</th><th>Detail</th></tr></thead><tbody>${lifecycle
    .map((event) =>
      event.type === "resize"
        ? `<tr><td>${formatDuration(event.atMs)}</td><td>resize</td><td>${event.cols} x ${event.rows}</td></tr>`
        : `<tr><td>${formatDuration(event.atMs)}</td><td>exit</td><td>${event.type === "exit" ? event.code : ""}</td></tr>`
    )
    .join("")}</tbody></table></div>`;
}

function recordingEventsTable(events: RecordingReportEvent[], replayEvents: number): string {
  const visible = events.slice(0, 200);
  return `<div class="table-wrap"><table><thead><tr><th>Time</th><th>Type</th><th>Summary</th></tr></thead><tbody>${visible
    .map((event) => {
      const detail =
        event.type === "output"
          ? `${Buffer.byteLength(event.data)} bytes`
          : event.type === "input"
            ? truncate(boundedJson(event.action, 240), 160)
            : event.type === "resize"
              ? `${event.cols} x ${event.rows}`
              : `code ${event.code}`;
      return `<tr><td>${formatDuration(event.atMs)}</td><td>${event.type}</td><td class="mono">${escapeHtml(detail)}</td></tr>`;
    })
    .join(
      ""
    )}</tbody></table></div>${events.length > visible.length ? `<p class="muted">Showing first ${visible.length} of ${events.length} events; timeline embeds ${replayEvents} replay events.</p>` : ""}`;
}

function shell(title: string, manifest: EvidenceManifest, body: string, data?: { id: string; value: unknown }): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
  <title>${escapeHtml(title)}</title>
  <style>${REPORT_CSS}</style>
</head>
<body>
  <header class="page-header"><div><div class="eyebrow">TuiLens evidence</div><h1>${escapeHtml(title)}</h1><div class="muted">${escapeHtml(manifest.kind)} · generated ${escapeHtml(manifest.generatedAt)} · ${escapeHtml(manifest.environment.platform)}/${escapeHtml(manifest.environment.arch)} · ${escapeHtml(manifest.environment.node)}</div></div><div class="badge ${manifest.summary.pass ? "good" : "bad"}">${manifest.summary.pass ? "passed" : "failed"}</div></header>
  <main>${body}</main>
  <script type="application/json" id="evidence-manifest">${jsonForScript(manifest)}</script>
  ${data ? `<script type="application/json" id="${escapeHtml(data.id)}">${jsonForScript(data.value)}</script>` : ""}
  <script>${REPORT_SCRIPT}</script>
</body>
</html>`;
}

function keyValue(items: [string, string][]): string {
  return `<dl class="kv">${items.map(([key, value]) => `<dt>${escapeHtml(key)}</dt><dd>${escapeHtml(value)}</dd>`).join("")}</dl>`;
}

function formatBytes(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return "unknown size";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${round(value / 1024, 1)} KiB`;
  return `${round(value / (1024 * 1024), 2)} MiB`;
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "unknown";
  if (ms < 1000) return `${round(ms, 1)} ms`;
  return `${round(ms / 1000, 2)} s`;
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function boundedJson(value: unknown, max: number): string {
  try {
    return truncate(JSON.stringify(value) ?? "null", max);
  } catch {
    return truncate(String(value), max);
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function escapeHtml(value: unknown): string {
  return String(value).replace(/[&<>"']/gu, (character) => HTML_ESCAPES[character] ?? character);
}

export function jsonForScript(value: unknown): string {
  return (JSON.stringify(value) ?? "null")
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

function isScenarioResult(value: unknown): value is ScenarioRunResult {
  const record = asRecord(value);
  if (!record) return false;
  if (record.matrix === true && Array.isArray(record.runs)) {
    return record.runs.some((run) => Array.isArray(asRecord(run)?.steps));
  }
  return Array.isArray(record.steps);
}

function isPerfResult(value: unknown): value is PerfMatrixResult | PerfResult {
  const record = asRecord(value);
  if (!record) return false;
  if (record.matrix === true && Array.isArray(record.runs)) {
    return record.runs.some((run) => Array.isArray(asRecord(run)?.metrics));
  }
  return Array.isArray(record.metrics) && Array.isArray(record.rounds);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

type Tone = "good" | "bad" | "warn" | "neutral";
type PerfMatrixFailureLike = Extract<PerfMatrixRun, { reportPath: null }>;

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

const REPORT_CSS = `
:root{color-scheme:dark light;--bg:#f5f7fb;--fg:#18202c;--muted:#5f6b7a;--card:#fff;--line:#dce3ec;--accent:#2563eb;--good:#157347;--bad:#b42318;--warn:#a15c00;--mono:ui-monospace,SFMono-Regular,Consolas,monospace}@media (prefers-color-scheme:dark){:root{--bg:#11151c;--fg:#e7edf6;--muted:#9aa8ba;--card:#18202b;--line:#2b3747;--accent:#7aa2ff;--good:#5bd6a2;--bad:#ff8b82;--warn:#f5c05f}}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}main{max-width:1280px;margin:0 auto;padding:24px}.page-header{max-width:1280px;margin:0 auto;padding:32px 24px 8px;display:flex;justify-content:space-between;gap:24px;align-items:flex-start}h1{font-size:30px;line-height:1.2;margin:4px 0 8px}h2{font-size:20px;margin:0 0 14px}h3{font-size:16px;margin:22px 0 10px}.eyebrow{color:var(--accent);font-weight:700;text-transform:uppercase;letter-spacing:.12em;font-size:11px}.muted{color:var(--muted)}.mono,pre,code{font-family:var(--mono)}.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:20px;margin:16px 0;box-shadow:0 1px 2px rgba(0,0,0,.04)}.summary{display:grid;grid-template-columns:repeat(auto-fit,minmax(145px,1fr));gap:12px;margin:18px 0}.metric{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px}.metric-label{font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em}.metric-value{font-size:22px;font-weight:700;margin-top:4px}.metric.good .metric-value{color:var(--good)}.metric.bad .metric-value{color:var(--bad)}.metric.warn .metric-value{color:var(--warn)}.badge{display:inline-flex;align-items:center;border:1px solid currentColor;border-radius:999px;padding:2px 9px;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.04em}.badge.good{color:var(--good)}.badge.bad{color:var(--bad)}.badge.warn{color:var(--warn)}.row-between{display:flex;justify-content:space-between;align-items:center;gap:16px}.kv{display:grid;grid-template-columns:minmax(120px,180px) 1fr;gap:7px 14px}.kv dt{color:var(--muted)}.kv dd{margin:0;overflow-wrap:anywhere}.table-wrap{overflow:auto}table{width:100%;border-collapse:collapse}th,td{text-align:left;border-bottom:1px solid var(--line);padding:8px 10px;vertical-align:top}th{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.05em}tr.regression{background:color-mix(in srgb,var(--bad) 10%,transparent)}.timeline{list-style:none;padding:0;margin:18px 0}.timeline-item{display:grid;grid-template-columns:22px 1fr;gap:10px;position:relative;padding-bottom:18px}.timeline-item:not(:last-child):before{content:"";position:absolute;left:10px;top:16px;bottom:-2px;width:2px;background:var(--line)}.timeline-dot{width:12px;height:12px;border-radius:50%;margin:5px 0 0 4px;background:var(--muted);position:relative;z-index:1}.timeline-item.pass .timeline-dot{background:var(--good)}.timeline-item.fail .timeline-dot{background:var(--bad)}.timeline-content{min-width:0}.step-detail{font-family:var(--mono);font-size:12px;color:var(--muted);margin:4px 0;overflow-wrap:anywhere}.error{background:color-mix(in srgb,var(--bad) 10%,var(--card));border-left:3px solid var(--bad);padding:10px;white-space:pre-wrap;overflow-wrap:anywhere;border-radius:6px}.warning{background:color-mix(in srgb,var(--warn) 12%,var(--card));border-left:3px solid var(--warn);padding:12px;border-radius:8px;margin:12px 0}.empty{color:var(--muted);padding:12px;border:1px dashed var(--line);border-radius:8px}.image-figure{margin:14px 0}.image-figure img,.compare-stage img{max-width:100%;height:auto;display:block;border:1px solid var(--line);border-radius:8px;background:#000}.image-figure figcaption{color:var(--muted);margin-top:6px;overflow-wrap:anywhere}.asset-missing{border:1px dashed var(--line);border-radius:8px;padding:12px;margin:12px 0;overflow-wrap:anywhere}.compare{margin:16px 0;max-width:900px}.compare-stage{position:relative;overflow:hidden;border-radius:8px}.compare-clip{position:absolute;inset:0 50% 0 0;overflow:hidden}.compare-clip img{width:100%;max-width:none}.compare-divider{position:absolute;top:0;bottom:0;left:50%;width:2px;background:var(--accent);box-shadow:0 0 0 1px var(--card)}.compare-range{width:100%;margin-top:10px}.compare-labels{display:flex;justify-content:space-between;color:var(--muted);font-size:12px}.compare-fallback{display:grid;gap:10px}.tabs{display:flex;gap:8px;flex-wrap:wrap;margin:18px 0 10px}.tab{border:1px solid var(--line);background:var(--card);color:var(--fg);border-radius:999px;padding:7px 14px;cursor:pointer}.tab.active{border-color:var(--accent);color:var(--accent)}.tab-panel{display:none}.tab-panel.active{display:block}.chart-wrap{overflow:auto;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:8px}.chart-wrap svg{width:100%;min-width:620px;height:auto}.chart-label{fill:var(--muted);font:11px var(--mono)}.chart-bar{fill:var(--accent);opacity:.78}.chart-p95{stroke:var(--warn);stroke-width:2}.axis{stroke:var(--line);stroke-width:1}.rss-total{fill:none;stroke:var(--accent);stroke-width:2}.rss-root{fill:none;stroke:var(--warn);stroke-width:2}.legend{display:flex;gap:18px;color:var(--muted);font-size:12px;padding:4px 6px 8px}.swatch{display:inline-block;width:12px;height:3px;margin-right:6px;vertical-align:middle}.swatch.total{background:var(--accent)}.swatch.root{background:var(--warn)}.recording-range{width:100%}.timeline-time{display:flex;justify-content:space-between;color:var(--muted);margin:8px 0}.recording-screen{background:#0b0f14;color:#d9e2ef;border:1px solid var(--line);border-radius:8px;padding:14px;min-height:260px;max-height:520px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere}details{margin:10px 0}summary{cursor:pointer;color:var(--accent)}pre{overflow:auto}@media(max-width:700px){.page-header{display:block}.kv{grid-template-columns:1fr}.metric-value{font-size:19px}}
`;

const REPORT_SCRIPT = `
(() => {
  const tabs = Array.from(document.querySelectorAll("[data-tab]"));
  for (const button of tabs) {
    button.addEventListener("click", () => {
      const target = button.getAttribute("data-tab");
      if (!target) return;
      for (const other of tabs) {
        other.classList.toggle("active", other === button);
        other.setAttribute("aria-selected", other === button ? "true" : "false");
      }
      for (const panel of document.querySelectorAll(".tab-panel")) panel.classList.toggle("active", panel.id === target);
    });
  }
  for (const root of document.querySelectorAll("[data-compare]")) {
    const range = root.querySelector("[type=range]");
    const clip = root.querySelector(".compare-clip");
    const divider = root.querySelector(".compare-divider");
    if (!(range instanceof HTMLInputElement) || !(clip instanceof HTMLElement) || !(divider instanceof HTMLElement)) continue;
    const update = () => {
      const value = Number(range.value);
      clip.style.right = (100 - value) + "%";
      divider.style.left = value + "%";
    };
    range.addEventListener("input", update);
    update();
  }
  const recordingNode = document.getElementById("recording-data");
  const range = document.getElementById("recording-range");
  const screen = document.getElementById("recording-screen");
  const time = document.getElementById("recording-time");
  if (recordingNode instanceof HTMLScriptElement && range instanceof HTMLInputElement && screen && time) {
    const data = JSON.parse(recordingNode.textContent || "{}");
    const events = Array.isArray(data.events) ? data.events : [];
    const esc = String.fromCharCode(27);
    const csi = new RegExp(esc + "\\\\[[0-?]*[ -/]*[@-~]", "g");
    const osc = new RegExp(esc + "\\\\][^\\\\x07]*(?:\\\\x07|" + esc + "\\\\\\\\)", "g");
    const strip = (text) => String(text).replace(osc, "").replace(csi, "");
    const render = () => {
      const at = Number(range.value);
      let text = "";
      for (const event of events) {
        if (!event || event.atMs > at) continue;
        if (event.type === "output") text += String(event.data || "");
        if (event.type === "exit") text += "\\n[process exited with code " + String(event.code) + "]";
      }
      screen.textContent = strip(text);
      if (data.truncated) screen.textContent = "[report text truncated]\\n" + screen.textContent;
      time.textContent = (at / 1000).toFixed(2) + " s";
    };
    range.addEventListener("input", render);
    render();
  }
})();
`;
