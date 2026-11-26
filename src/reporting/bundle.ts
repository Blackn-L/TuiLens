import { copyFile, mkdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { readBoundedFile } from "../core/bounded-file.js";
import { TuiLensError } from "../core/errors.js";
import type { PerfMatrixResult, PerfResult } from "../perf/runner.js";
import type { ScenarioMatrixResult, ScenarioResult, ScenarioRunResult } from "../scenario/runner.js";

export const EVIDENCE_BUNDLE_VERSION = 1 as const;
export const MAX_RECORDING_REPORT_BYTES = 64 * 1024 * 1024;
export const MAX_RECORDING_REPORT_EVENTS = 100_000;

export type EvidenceKind = "scenario" | "scenario-matrix" | "perf" | "perf-matrix" | "recording";

export type EvidenceArtifactRole =
  | "report"
  | "screenshot"
  | "failure-screenshot"
  | "compare-baseline"
  | "compare-actual"
  | "compare-diff"
  | "baseline"
  | "recording";

export interface EvidenceArtifact {
  role: EvidenceArtifactRole;
  path: string;
  mimeType: string;
  bytes?: number;
  label?: string;
  stepIndex?: number;
  profile?: string;
}

export interface EvidenceEnvironment {
  platform: string;
  node: string;
  arch: string;
  cols?: number;
  rows?: number;
  terminalProfile?: string;
  renderer?: string;
}

export interface EvidenceSummary {
  pass: boolean;
  runs?: number;
  profiles?: string[];
  steps?: number;
  failures?: number;
  metrics?: number;
  regressions?: number;
  errors?: number;
  events?: number;
  durationMs?: number;
  truncated?: boolean;
}

export interface EvidenceManifest {
  version: typeof EVIDENCE_BUNDLE_VERSION;
  kind: EvidenceKind;
  generatedAt: string;
  environment: EvidenceEnvironment;
  summary: EvidenceSummary;
  payloadPath: string;
  artifacts: EvidenceArtifact[];
}

export interface EvidenceBuildOptions {
  generatedAt?: string;
}

export interface RecordingHeaderReport {
  version: 2;
  cols: number;
  rows: number;
  renderer: string;
  terminalProfile?: string;
}

export type RecordingReportEvent =
  | { type: "output"; atMs: number; data: string }
  | { type: "input"; atMs: number; action: unknown }
  | { type: "resize"; atMs: number; cols: number; rows: number }
  | { type: "exit"; atMs: number; code: number };

export interface RecordingReport {
  path: string;
  header: RecordingHeaderReport;
  events: RecordingReportEvent[];
  complete: boolean;
  truncated: boolean;
  durationMs: number;
  exitCode?: number;
}

export async function buildScenarioEvidence(
  result: ScenarioRunResult,
  options: EvidenceBuildOptions = {}
): Promise<EvidenceManifest> {
  const matrix = isScenarioMatrixResult(result);
  const runs = matrix ? result.runs : [result];
  const artifacts: EvidenceArtifact[] = [];
  for (const run of runs) await addScenarioArtifacts(artifacts, run);
  const first = runs[0];
  const failures = runs.filter((run) => !run.pass).length;
  const steps = runs.reduce((count, run) => count + run.steps.length, 0);
  return {
    version: EVIDENCE_BUNDLE_VERSION,
    kind: matrix ? "scenario-matrix" : "scenario",
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    environment: {
      platform: process.platform,
      node: process.version,
      arch: process.arch,
      ...(first?.cols === undefined ? {} : { cols: first.cols }),
      ...(first?.rows === undefined ? {} : { rows: first.rows }),
      ...(first?.terminalProfile ? { terminalProfile: first.terminalProfile } : {}),
      ...(first?.renderer ? { renderer: first.renderer } : {}),
    },
    summary: {
      pass: result.pass,
      runs: runs.length,
      ...(matrix ? { profiles: [...result.profiles] } : {}),
      steps,
      failures,
    },
    payloadPath: resolve(result.reportPath),
    artifacts: dedupeArtifacts(artifacts),
  };
}

export async function buildPerfEvidence(
  result: PerfMatrixResult | PerfResult,
  options: EvidenceBuildOptions = {}
): Promise<EvidenceManifest> {
  const matrix = isPerfMatrixResult(result);
  const runs = matrix ? result.runs : [result];
  const artifacts: EvidenceArtifact[] = [];
  for (const run of runs) {
    if (run.reportPath === null) continue;
    await addArtifact(artifacts, run.reportPath, "report", {
      ...(run.environment.terminalProfile ? { profile: run.environment.terminalProfile } : {}),
      label: "Performance report JSON",
    });
    if ("baselinePath" in run && run.baselinePath) {
      await addArtifact(artifacts, run.baselinePath, "baseline", {
        ...(run.environment.terminalProfile ? { profile: run.environment.terminalProfile } : {}),
        label: "Performance baseline",
      });
    }
    if (run.writtenBaselinePath) {
      await addArtifact(artifacts, run.writtenBaselinePath, "baseline", {
        ...(run.environment.terminalProfile ? { profile: run.environment.terminalProfile } : {}),
        label: "Updated performance baseline",
      });
    }
  }
  const first = runs.find((run): run is PerfResult => run.reportPath !== null);
  const metrics = runs.reduce((count, run) => count + (run.reportPath === null ? 0 : run.metrics.length), 0);
  const errors = runs.reduce((count, run) => count + (run.reportPath === null ? 1 : run.errors.length), 0);
  const regressions = runs.reduce((count, run) => count + (run.reportPath === null ? 0 : run.regressions.length), 0);
  return {
    version: EVIDENCE_BUNDLE_VERSION,
    kind: matrix ? "perf-matrix" : "perf",
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    environment: first?.environment ?? {
      platform: process.platform,
      node: process.version,
      arch: process.arch,
    },
    summary: {
      pass: result.pass,
      runs: matrix ? result.runs.length : 1,
      ...(matrix ? { profiles: [...result.profiles] } : {}),
      metrics,
      errors,
      ...(first ? { regressions } : {}),
    },
    payloadPath: resolve(result.reportPath),
    artifacts: dedupeArtifacts(artifacts),
  };
}

export function isScenarioMatrixResult(value: ScenarioRunResult): value is ScenarioMatrixResult {
  return "matrix" in value && value.matrix === true;
}

export function isPerfMatrixResult(value: PerfResult | PerfMatrixResult): value is PerfMatrixResult {
  return "matrix" in value && value.matrix === true;
}

export function buildRecordingEvidence(
  recording: RecordingReport,
  options: EvidenceBuildOptions = {}
): EvidenceManifest {
  return {
    version: EVIDENCE_BUNDLE_VERSION,
    kind: "recording",
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    environment: {
      platform: process.platform,
      node: process.version,
      arch: process.arch,
      cols: recording.header.cols,
      rows: recording.header.rows,
      ...(recording.header.terminalProfile ? { terminalProfile: recording.header.terminalProfile } : {}),
      renderer: recording.header.renderer,
    },
    summary: {
      pass: !recording.truncated,
      runs: 1,
      events: recording.events.length,
      durationMs: recording.durationMs,
      truncated: recording.truncated,
    },
    payloadPath: resolve(recording.path),
    artifacts: [
      {
        role: "recording",
        path: resolve(recording.path),
        mimeType: "application/x-ndjson",
        label: "Terminal recording",
      },
    ],
  };
}

export async function writeEvidenceManifest(path: string, manifest: EvidenceManifest): Promise<void> {
  const target = resolve(path);
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  await writeFile(target, JSON.stringify(manifest, null, 2), { mode: 0o644 });
}

export async function writeEvidenceBundle(
  manifest: EvidenceManifest,
  payload: unknown,
  directory: string
): Promise<{ manifestPath: string; payloadPath: string; manifest: EvidenceManifest }> {
  const target = resolve(directory);
  await mkdir(target, { recursive: true, mode: 0o700 });
  const payloadPath = join(target, "payload.json");
  await writeFile(payloadPath, JSON.stringify(payload, null, 2), { mode: 0o644 });
  const sourcePayload = resolve(manifest.payloadPath);
  const artifacts: EvidenceArtifact[] = [];
  for (const [index, artifact] of manifest.artifacts.entries()) {
    const source = resolve(artifact.path);
    if (artifact.role === "report" && source === sourcePayload) {
      artifacts.push({ ...artifact, path: "payload.json" });
      continue;
    }
    const artifactDir = join(target, "artifacts");
    await mkdir(artifactDir, { recursive: true, mode: 0o700 });
    const name = bundleFileName(artifact.role, artifact.path, index);
    const destination = join(artifactDir, name);
    await copyFile(source, destination);
    artifacts.push({ ...artifact, path: join("artifacts", name) });
  }
  const next = { ...manifest, payloadPath: "payload.json", artifacts };
  const manifestPath = join(target, "evidence.json");
  await writeEvidenceManifest(manifestPath, next);
  return { manifestPath, payloadPath, manifest: next };
}

function bundleFileName(role: EvidenceArtifactRole, path: string, index: number): string {
  const raw = basename(path)
    .replace(/[^A-Za-z0-9._-]/gu, "_")
    .replace(/^\.+/u, "")
    .slice(-120);
  return `${String(index + 1).padStart(3, "0")}-${role}-${raw || "artifact"}`;
}

export async function readRecordingReport(path: string): Promise<RecordingReport> {
  const source = resolve(path);
  const text = (await readBoundedFile(source, MAX_RECORDING_REPORT_BYTES)).toString("utf8");
  const lines = text.split(/\r?\n/u).filter((line) => line.length > 0);
  if (!lines.length) throw new TuiLensError("INCOMPLETE_RECORDING", "录制文件为空");
  const header = parseHeader(lines[0]!);
  const events: RecordingReportEvent[] = [];
  let previous = 0;
  let complete = false;
  let truncated = false;
  let exitCode: number | undefined;
  for (let index = 1; index < lines.length; index += 1) {
    if (events.length >= MAX_RECORDING_REPORT_EVENTS) {
      throw new TuiLensError("RECORDING_EVENT_LIMIT", "录制事件超过报告上限", {
        maxEvents: MAX_RECORDING_REPORT_EVENTS,
      });
    }
    const record = parseRecord(lines[index]!);
    if (record.atMs < previous) throw new TuiLensError("INVALID_RECORDING", "录制时间戳未按序排列");
    previous = record.atMs;
    if (record.type === "end") {
      complete = true;
      truncated = record.truncated;
      if (index !== lines.length - 1) throw new TuiLensError("INVALID_RECORDING", "录制中存在提前结束标记");
      break;
    }
    if (record.type === "input") {
      events.push({ type: "input", atMs: record.atMs, action: record.action });
    } else if (record.type === "output") {
      events.push({ type: "output", atMs: record.atMs, data: record.data });
    } else if (record.type === "resize") {
      events.push({ type: "resize", atMs: record.atMs, cols: record.cols, rows: record.rows });
    } else {
      exitCode = record.code;
      events.push({ type: "exit", atMs: record.atMs, code: record.code });
    }
  }
  if (!complete) truncated = true;
  return {
    path: source,
    header,
    events,
    complete,
    truncated,
    durationMs: previous,
    ...(exitCode === undefined ? {} : { exitCode }),
  };
}

function parseHeader(line: string): RecordingHeaderReport {
  const value = parseJson(line);
  const record = asRecord(value);
  if (
    !record ||
    record.type !== "header" ||
    record.version !== 2 ||
    !validColumns(record.cols) ||
    !validRows(record.rows) ||
    typeof record.renderer !== "string"
  ) {
    throw new TuiLensError("INVALID_RECORDING", "录制头部格式或版本不受支持");
  }
  const profile = asRecord(record.profile);
  return {
    version: 2,
    cols: record.cols,
    rows: record.rows,
    renderer: record.renderer,
    ...(typeof profile?.name === "string" ? { terminalProfile: profile.name } : {}),
  };
}

type ParsedRecord =
  | { type: "output"; atMs: number; data: string }
  | { type: "input"; atMs: number; action: unknown }
  | { type: "resize"; atMs: number; cols: number; rows: number }
  | { type: "exit"; atMs: number; code: number }
  | { type: "end"; atMs: number; truncated: boolean };

function parseRecord(line: string): ParsedRecord {
  const record = asRecord(parseJson(line));
  if (!record || typeof record.type !== "string" || !validTime(record.atMs)) {
    throw new TuiLensError("INVALID_RECORDING", "录制事件格式不合法");
  }
  switch (record.type) {
    case "output":
      if (typeof record.data !== "string") throw invalidRecord();
      return { type: "output", atMs: record.atMs, data: record.data };
    case "input":
      return { type: "input", atMs: record.atMs, action: record.action };
    case "resize":
      if (!validColumns(record.cols) || !validRows(record.rows)) throw invalidRecord();
      return { type: "resize", atMs: record.atMs, cols: record.cols, rows: record.rows };
    case "exit":
      if (typeof record.code !== "number" || !Number.isInteger(record.code)) throw invalidRecord();
      return { type: "exit", atMs: record.atMs, code: record.code };
    case "end":
      if (typeof record.truncated !== "boolean") throw invalidRecord();
      return { type: "end", atMs: record.atMs, truncated: record.truncated };
    default:
      throw invalidRecord();
  }
}

async function addScenarioArtifacts(artifacts: EvidenceArtifact[], run: ScenarioResult): Promise<void> {
  const profile = run.terminalProfile;
  await addArtifact(artifacts, run.reportPath, "report", {
    ...(profile ? { profile } : {}),
    label: "Scenario report JSON",
  });
  for (const step of run.steps) {
    const result = asRecord(step.result);
    if (!result) continue;
    if (typeof result.path === "string" && typeof result.width === "number" && typeof result.height === "number") {
      await addArtifact(artifacts, result.path, "screenshot", {
        stepIndex: step.index,
        ...(profile ? { profile } : {}),
        label: `Step ${step.index + 1} screenshot`,
      });
      continue;
    }
    for (const [key, role] of [
      ["baseline", "compare-baseline"],
      ["actual", "compare-actual"],
      ["diff", "compare-diff"],
    ] as const) {
      if (typeof result[key] === "string") {
        await addArtifact(artifacts, result[key], role, {
          stepIndex: step.index,
          ...(profile ? { profile } : {}),
          label: `Step ${step.index + 1} ${key}`,
        });
      }
    }
  }
  if (run.failureScreenshot) {
    await addArtifact(artifacts, run.failureScreenshot, "failure-screenshot", {
      ...(profile ? { profile } : {}),
      label: "Failure screenshot",
    });
  }
}

async function addArtifact(
  artifacts: EvidenceArtifact[],
  path: string,
  role: EvidenceArtifactRole,
  extra: Omit<EvidenceArtifact, "path" | "role" | "mimeType" | "bytes"> = {}
): Promise<void> {
  const target = resolve(path);
  const info = await stat(target).catch(() => null);
  artifacts.push({
    role,
    path: target,
    mimeType: mimeTypeForPath(target),
    ...(info?.isFile() ? { bytes: info.size } : {}),
    ...extra,
  });
}

function dedupeArtifacts(artifacts: EvidenceArtifact[]): EvidenceArtifact[] {
  const seen = new Set<string>();
  return artifacts.filter((artifact) => {
    const key = `${artifact.role}\0${artifact.path}\0${artifact.stepIndex ?? ""}\0${artifact.profile ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function mimeTypeForPath(path: string): string {
  const extension = extname(path).toLowerCase();
  if (extension === ".png") return "image/png";
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  if (extension === ".webp") return "image/webp";
  if (extension === ".json") return "application/json";
  if (extension === ".jsonl" || extension === ".ndjson") return "application/x-ndjson";
  if (extension === ".html" || extension === ".htm") return "text/html";
  if (extension === ".md" || extension === ".markdown") return "text/markdown";
  return "application/octet-stream";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new TuiLensError("INVALID_RECORDING", "录制文件不是有效 JSONL");
  }
}

function validColumns(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 2 && value <= 500;
}

function validRows(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 2 && value <= 250;
}

function validTime(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 7 * 24 * 60 * 60 * 1000;
}

function invalidRecord(): TuiLensError {
  return new TuiLensError("INVALID_RECORDING", "录制事件格式不合法");
}
