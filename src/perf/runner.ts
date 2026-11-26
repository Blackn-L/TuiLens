import { randomUUID } from "node:crypto";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { readBoundedFile } from "../core/bounded-file.js";
import { errorRecord, TuiLensError, type ErrorRecord } from "../core/errors.js";
import { pick } from "../core/i18n.js";
import type {
  InputAction,
  LaunchOptions,
  ProgressReporter,
  RendererKind,
  SessionInfo,
  WaitCondition,
} from "../core/types.js";
import type { SessionManager } from "../session/manager.js";
import { ProcessTreeSampler } from "./resource.js";
import { perfSpecSchema, type PerfSample, type PerfSpec } from "./schema.js";
import { rounded, summarize, type SampleSummary } from "./stats.js";

/** 单个测量单元的聚合结果，单位为毫秒。 */
export interface MetricSummary {
  phase: string;
  name: string;
  /** 输入发出到目标条件成立的实际耗时（不含准备动作）。 */
  elapsedMs: SampleSummary;
  /** 同一批样本最近一次写入到浏览器绘制的耗时。 */
  paintMs?: SampleSummary;
  samples: number;
}

export interface Stability {
  /** 最大值 / 中位数；偏高说明偶发抖动而非稳定劣化。 */
  spread: number;
  verdict: "stable" | "noisy" | "unstable";
}

export interface PerfRound {
  round: number;
  startupMs: number;
  metrics: MetricSummary[];
  session: { receivedBytes: number; appliedBytes: number; writeBatches: number };
  /** 原始采样值，仅用于跨轮次合并；写入报告前剥离。 */
  raw?: { phase: string; name: string; elapsed: number[]; paint?: number[] }[];
}

export interface MetricComparison {
  phase: string;
  name: string;
  baselineP50: number;
  currentP50: number;
  changeRatio: number;
  baselineP95: number;
  currentP95: number;
  regression: boolean;
}

export interface BaselineFile {
  version: 1;
  createdAt: string;
  environment: Environment;
  metrics: { phase: string; name: string; p50: number; p95: number; p99: number }[];
}

export interface Environment {
  platform: string;
  node: string;
  arch: string;
  cols: number;
  rows: number;
  /** 新报告记录实际 profile；旧基线缺省时仍允许比较。 */
  terminalProfile?: string;
  /** 新报告记录实际 renderer；旧基线缺省时仍允许比较。 */
  renderer?: RendererKind;
}

export interface PerfError {
  round: number;
  phase?: string;
  sample?: string;
  error: ErrorRecord;
}

export interface PerfRssPoint {
  round: number;
  atMs: number;
  rssBytes: number;
  rootRssBytes: number;
  processes: number;
}

export interface PerfResult {
  pass: boolean;
  reportPath: string;
  environment: Environment;
  settings: { rounds: number; repeats: number; warmupRounds: number; maxRegression: number };
  metrics: (MetricSummary & { stability: Stability })[];
  /** 首轮预热（若配置）的启动耗时，只作参考不参与判定。 */
  warmupStartupMs: number | null;
  processTree: {
    peakRssBytes: number;
    peakRootRssBytes: number;
    peakProcesses: number;
    samples: number;
    errors: number;
    lastError?: string;
    intervalMs: number;
    /** 有界采样时间线，供 HTML 报告绘图；完整峰值仍以 peak 字段为准。 */
    timeline?: PerfRssPoint[];
    /** 采样频率有限，峰值是下界而不是精确值。 */
    approximate: true;
  };
  rounds: PerfRound[];
  /** 每个指标相对基线的变化；未提供基线时为空。 */
  comparisons: MetricComparison[];
  regressions: string[];
  baselinePath?: string;
  /** 同时比较和更新基线时，区分用于比较的文件与新写出的测量。 */
  writtenBaselinePath?: string;
  errors: PerfError[];
}

export interface PerfMatrixValue {
  profile: string;
  p50: number;
  p95: number;
  stability: Stability["verdict"];
}

export interface PerfMatrixRow {
  phase: string;
  name: string;
  values: PerfMatrixValue[];
}

export interface PerfMatrixResult {
  pass: boolean;
  matrix: true;
  reportPath: string;
  profiles: string[];
  table: PerfMatrixRow[];
  runs: PerfMatrixRun[];
}

export interface PerfMatrixFailure {
  pass: false;
  reportPath: null;
  profile: string;
  environment: Environment;
  error: PerfError["error"];
}

export type PerfMatrixRun = PerfResult | PerfMatrixFailure;

function isMatrixRunSuccess(run: PerfMatrixRun): run is PerfResult {
  return run.reportPath !== null;
}

export type PerfRunResult = PerfResult | PerfMatrixResult;

export interface PerfRunOptions {
  spec: unknown;
  directory: string;
  /** 基线文件路径；存在时读取并比较。 */
  baseline?: string;
  /** 运行结束后把本轮结果写成基线（供下次比较）。 */
  writeBaseline?: string;
  /** 相对基线允许的最大 p50 涨幅，默认 0.15（15%）。 */
  maxRegression?: number;
  /** 环境指纹不一致时仍然比较，但在结果中保留对比数据。 */
  allowEnvironmentMismatch?: boolean;
  /** 每个轮次结束后推送真实进度。 */
  onProgress?: ProgressReporter;
  signal?: AbortSignal;
}

/** 递归剔除值为 undefined 的字段，适配 exactOptionalPropertyTypes。 */
function withoutUndefined<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => withoutUndefined(item)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .map(([key, item]) => [key, withoutUndefined(item)])
    ) as T;
  }
  return value;
}

/** 抖动分级：跨度小于 25% 视为稳定，超过 100% 视为不稳定。 */
function stabilityOf(summary: SampleSummary): Stability {
  const spread = summary.p50 > 0 ? rounded(summary.max / summary.p50) : 1;
  return { spread, verdict: spread < 1.25 ? "stable" : spread < 2 ? "noisy" : "unstable" };
}

function describeError(error: unknown): PerfError["error"] {
  return errorRecord(error);
}

function describeSample(sample: PerfSample): string {
  const action = sample.input as { type: string; text?: string; key?: string; x?: number; y?: number };
  const target = action.text ?? action.key ?? "";
  if (target) return `${action.type}:${target.slice(0, 24)}`;
  if (action.x !== undefined && action.y !== undefined) return `${action.type}:${action.x},${action.y}`;
  return action.type;
}

/**
 * 执行一次性能场景。
 *
 * 每个轮次都会重新启动被测程序，因此进程内状态（缓存、历史积累）不会跨轮次泄漏；
 * 阶段内的 `setup` 用来按需重建历史，让「长对话后变慢」是真实增长而非噪声。
 * 测量期间不做截图，也不读取整屏字符格，避免工具自身开销主导结果。
 */
export async function runPerf(manager: SessionManager, options: PerfRunOptions): Promise<PerfRunResult> {
  const parsed = perfSpecSchema.safeParse(options.spec);
  if (!parsed.success) {
    throw new TuiLensError("INVALID_PERF_SPEC", "性能场景格式不合法", parsed.error.issues);
  }
  const spec = parsed.data;
  if (spec.profiles) return runPerfMatrix(manager, spec, options);
  return runPerfSingle(manager, spec, options);
}

async function runPerfMatrix(
  manager: SessionManager,
  spec: PerfSpec,
  options: PerfRunOptions
): Promise<PerfMatrixResult> {
  const profiles = spec.profiles!;
  if (profiles.length > 1 && (options.baseline !== undefined || options.writeBaseline !== undefined)) {
    throw new TuiLensError("INVALID_ARGUMENT", "多 profile 矩阵不能共享单个性能基线；请按 profile 分别运行");
  }
  const { profiles: _profiles, ...base } = spec;
  const runs: PerfMatrixRun[] = [];
  for (const profile of profiles) {
    if (options.signal?.aborted) throw new TuiLensError("ABORTED", "性能运行已取消");
    const runOptions = options.onProgress
      ? {
          ...options,
          onProgress: (progress: Parameters<ProgressReporter>[0]) => options.onProgress?.({ ...progress, profile }),
        }
      : options;
    try {
      runs.push(
        await runPerfSingle(
          manager,
          {
            ...base,
            launch: { ...base.launch, terminalProfile: profile } as LaunchOptions,
          },
          runOptions
        )
      );
    } catch (error) {
      if (options.signal?.aborted) throw error;
      runs.push({
        pass: false,
        reportPath: null,
        profile,
        environment: {
          platform: process.platform,
          node: process.version,
          arch: process.arch,
          cols: base.launch.cols ?? 160,
          rows: base.launch.rows ?? 50,
          terminalProfile: profile,
        },
        error: describeError(error),
      });
    }
  }
  const table: PerfMatrixRow[] = [];
  const rows = new Map<string, PerfMatrixRow>();
  for (const run of runs) {
    if (!isMatrixRunSuccess(run)) continue;
    const profile = run.environment.terminalProfile ?? "unknown";
    for (const metric of run.metrics) {
      const key = `${metric.phase}\u0000${metric.name}`;
      let row = rows.get(key);
      if (!row) {
        row = { phase: metric.phase, name: metric.name, values: [] };
        rows.set(key, row);
        table.push(row);
      }
      row.values.push({
        profile,
        p50: metric.elapsedMs.p50,
        p95: metric.elapsedMs.p95,
        stability: metric.stability.verdict,
      });
    }
  }
  await mkdir(options.directory, { recursive: true, mode: 0o700 });
  const result: PerfMatrixResult = {
    pass: runs.length === profiles.length && runs.every((run) => run.pass),
    matrix: true,
    reportPath: join(options.directory, `perf-matrix-${randomUUID()}.json`),
    profiles: [...profiles],
    table,
    runs,
  };
  await writeFile(result.reportPath, JSON.stringify(result, null, 2), { mode: 0o600 });
  return result;
}

async function runPerfSingle(manager: SessionManager, spec: PerfSpec, options: PerfRunOptions): Promise<PerfResult> {
  // zod 的可选字段会带显式 undefined，而 LaunchOptions 在
  // exactOptionalPropertyTypes 下只接受缺省字段；这里统一剥离。
  const launch = withoutUndefined(spec.launch) as LaunchOptions;
  const rounds = spec.rounds ?? 3;
  const repeats = spec.repeats ?? 1;
  const warmupRounds = spec.warmupRounds ?? 0;
  const maxRegression = options.maxRegression ?? 0.15;
  if (!Number.isFinite(maxRegression) || maxRegression < 0 || maxRegression > 10) {
    throw new TuiLensError("INVALID_ARGUMENT", "maxRegression 必须是 0～10 的小数");
  }
  await mkdir(options.directory, { recursive: true, mode: 0o700 });

  const collected: PerfRound[] = [];
  const errors: PerfError[] = [];
  let peakRss = 0;
  let peakRootRss = 0;
  let peakProcesses = 0;
  let rssSamples = 0;
  let rssErrors = 0;
  let rssLastError: string | undefined;
  let rssIntervalMs = 0;
  const rssTimeline: PerfRssPoint[] = [];
  let warmupStartupMs: number | null = null;
  let terminalProfile = spec.launch.terminalProfile ?? "xterm-256color";
  let renderer: RendererKind | undefined;

  for (let round = 1; round <= rounds + warmupRounds; round += 1) {
    if (options.signal?.aborted) throw new TuiLensError("ABORTED", "性能运行已取消");
    const warmup = round <= warmupRounds;
    const roundNumber = round - warmupRounds;
    const started = performance.now();
    let sessionId: string | undefined;
    let sampler: ProcessTreeSampler | undefined;
    try {
      const session = await manager.launch(launch);
      sessionId = session.id;
      terminalProfile = session.terminalProfile ?? terminalProfile;
      // 就绪条件必须在测量开始前成立：程序进入 raw mode 之前的输入会被吞掉，
      // 否则首个采样会以一个假超时结束整轮。
      if (spec.ready?.length) {
        await manager.wait(session.id, {
          conditions: spec.ready as WaitCondition[],
          timeoutMs: spec.readyTimeoutMs ?? 30_000,
          ...(options.signal ? { signal: options.signal } : {}),
        });
      }
      const startupMs = rounded(performance.now() - started);
      if (warmup) {
        warmupStartupMs = startupMs;
        continue;
      }
      // paint 可按需启动浏览器。先确定本轮的实际渲染器，再执行 setup 与计时输入。
      const textOnly = launch.renderer === "headless" && session.renderer !== "dom" && session.renderer !== "webgl";
      const measurePaint =
        !textOnly && (await manager.paint(session.id, options.signal ? { signal: options.signal } : {})) !== undefined;
      const sampleSession = measurePaint
        ? (manager.list().find((entry) => entry.id === session.id) ?? session)
        : session;
      if (collected.length > 0) requireSameRenderer(renderer, sampleSession.renderer);
      if (spec.measure?.processTree !== false) {
        sampler = new ProcessTreeSampler(session.pid, 1000);
        sampler.start();
      }
      const metrics: MetricSummary[] = [];
      const raw: NonNullable<PerfRound["raw"]> = [];
      // 轮次内发出的输入计数；`{{seq}}` 用它定位「这一次」产生的证据。
      const sequence = { value: 0 };
      for (const phase of spec.phases) {
        await runSetup(manager, session.id, phase.setup ?? [], sequence, options.signal);
        for (const sample of phase.samples) {
          const elapsed: number[] = [];
          const paint: number[] = [];
          for (let repeat = 0; repeat < repeats; repeat += 1) {
            if (options.signal?.aborted) throw new TuiLensError("ABORTED", "性能运行已取消");
            const measured = await measureSample(
              manager,
              sampleSession,
              sample,
              sequence,
              measurePaint,
              options.signal
            );
            elapsed.push(measured.elapsed);
            if (measured.paintMs !== undefined) paint.push(measured.paintMs);
          }
          const name = sample.name ?? describeSample(sample);
          metrics.push({
            phase: phase.name,
            name,
            elapsedMs: summarize(elapsed),
            ...(paint.length ? { paintMs: summarize(paint) } : {}),
            samples: elapsed.length,
          });
          raw.push({ phase: phase.name, name, elapsed, ...(paint.length ? { paint } : {}) });
        }
      }
      const info = manager.metrics(session.id);
      renderer = sampleSession.renderer;
      collected.push({
        round: roundNumber,
        startupMs,
        metrics,
        raw,
        session: {
          receivedBytes: info.receivedBytes,
          appliedBytes: info.appliedBytes,
          writeBatches: info.writeBatches,
        },
      });
    } catch (error) {
      // 单轮失败不应掩盖其他轮次的数据；失败详情必须进入报告。
      errors.push({ round: roundNumber, error: describeError(error) });
    } finally {
      if (sampler) {
        const sampled = await sampler.stop();
        peakRss = Math.max(peakRss, sampled.peakRssBytes);
        peakRootRss = Math.max(peakRootRss, sampled.peakRootRssBytes);
        peakProcesses = Math.max(peakProcesses, sampled.peakProcesses);
        rssSamples += sampled.samples;
        rssErrors += sampled.errors;
        if (sampled.lastError !== undefined) rssLastError = sampled.lastError;
        rssIntervalMs = sampled.intervalMs;
        for (const point of sampled.timeline) {
          if (rssTimeline.length >= 512) break;
          rssTimeline.push({ round: roundNumber, ...point });
        }
      }
      if (sessionId) {
        try {
          await manager.close(sessionId);
        } catch (error) {
          errors.push({ round: roundNumber, error: describeError(error) });
        }
      }
      options.onProgress?.({
        kind: "perf",
        ...(terminalProfile ? { profile: terminalProfile } : {}),
        current: round,
        total: rounds + warmupRounds,
        elapsedMs: Math.round(performance.now() - started),
      });
    }
  }
  if (!collected.length) {
    throw new TuiLensError("PERF_NO_DATA", "性能运行没有产生任何有效轮次", { errors });
  }

  const merged = mergeRounds(collected).map((metric) => ({
    ...metric,
    stability: stabilityOf(metric.elapsedMs),
  }));
  const environment: Environment = {
    platform: process.platform,
    node: process.version,
    arch: process.arch,
    cols: spec.launch.cols ?? 160,
    rows: spec.launch.rows ?? 50,
    terminalProfile,
    ...(renderer ? { renderer } : {}),
  };
  const baseline = options.baseline ? await readBaseline(options.baseline) : undefined;
  const comparisons: MetricComparison[] = [];
  const regressions: string[] = [];
  if (baseline) {
    const matches =
      baseline.environment.platform === environment.platform &&
      baseline.environment.cols === environment.cols &&
      baseline.environment.rows === environment.rows &&
      (baseline.environment.terminalProfile === undefined ||
        baseline.environment.terminalProfile === environment.terminalProfile) &&
      (baseline.environment.renderer === undefined || baseline.environment.renderer === environment.renderer);
    if (!matches && options.allowEnvironmentMismatch !== true) {
      throw new TuiLensError("PERF_ENVIRONMENT_MISMATCH", "基线环境与当前运行不一致，不能直接比较", {
        baseline: baseline.environment,
        current: environment,
        hint: pick(
          "Use the same platform and grid, or explicitly allow cross-environment comparison.",
          "确认平台与网格一致，或在选项中显式允许跨环境比较"
        ),
      });
    }
    for (const metric of merged) {
      const previous = baseline.metrics.find((item) => item.phase === metric.phase && item.name === metric.name);
      if (!previous) continue;
      const change = previous.p50 > 0 ? (metric.elapsedMs.p50 - previous.p50) / previous.p50 : 0;
      const regression = change > maxRegression;
      comparisons.push({
        phase: metric.phase,
        name: metric.name,
        baselineP50: previous.p50,
        currentP50: metric.elapsedMs.p50,
        changeRatio: rounded(change),
        baselineP95: previous.p95,
        currentP95: metric.elapsedMs.p95,
        regression,
      });
      if (regression) {
        regressions.push(
          `${metric.phase}/${metric.name}: p50 ${previous.p50} → ${metric.elapsedMs.p50} ms` +
            pick(
              ` (+${Math.round(change * 100)}%, threshold ${Math.round(maxRegression * 100)}%)`,
              ` (+${Math.round(change * 100)}%，阈值 ${Math.round(maxRegression * 100)}%)`
            )
        );
      }
    }
  }

  const reportPath = join(options.directory, `perf-${randomUUID()}.json`);
  const result: PerfResult = {
    pass: regressions.length === 0 && errors.length === 0,
    reportPath,
    environment,
    settings: { rounds, repeats, warmupRounds, maxRegression },
    metrics: merged,
    warmupStartupMs,
    processTree: {
      peakRssBytes: peakRss,
      peakRootRssBytes: peakRootRss,
      peakProcesses,
      samples: rssSamples,
      errors: rssErrors,
      ...(rssLastError === undefined ? {} : { lastError: rssLastError }),
      intervalMs: rssIntervalMs,
      timeline: rssTimeline,
      approximate: true,
    },
    rounds: collected,
    comparisons,
    regressions,
    ...(options.baseline ? { baselinePath: resolve(options.baseline) } : {}),
    errors,
  };
  if (options.writeBaseline) {
    const destination = resolve(options.writeBaseline);
    if (baseline && result.baselinePath) {
      if (await sameFile(result.baselinePath, destination)) {
        // 更新同一文件前保留本次已读取的比较依据，供报告和证据包复核。
        result.baselinePath = resolve(options.directory, `compared-baseline-${randomUUID()}.json`);
        await writeFile(result.baselinePath, JSON.stringify(baseline, null, 2), { mode: 0o600 });
      }
      result.writtenBaselinePath = destination;
    }
    const file: BaselineFile = {
      version: 1,
      createdAt: new Date().toISOString(),
      environment,
      metrics: merged.map((metric) => ({
        phase: metric.phase,
        name: metric.name,
        p50: metric.elapsedMs.p50,
        p95: metric.elapsedMs.p95,
        p99: metric.elapsedMs.p99,
      })),
    };
    await writeFile(destination, JSON.stringify(file, null, 2), { mode: 0o644 });
    result.baselinePath ??= destination;
  }
  await writeFile(reportPath, JSON.stringify(result, null, 2), { mode: 0o600 });
  return result;
}

async function sameFile(source: string, destination: string): Promise<boolean> {
  if (source === destination) return true;
  try {
    const [left, right] = await Promise.all([stat(source, { bigint: true }), stat(destination, { bigint: true })]);
    return left.dev === right.dev && left.ino === right.ino;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function readBaseline(path: string): Promise<BaselineFile> {
  const text = (await readBoundedFile(path, 4 * 1024 * 1024)).toString("utf8");
  let value: BaselineFile;
  try {
    value = JSON.parse(text) as BaselineFile;
  } catch (error) {
    throw new TuiLensError("INVALID_BASELINE", "性能基线文件不是有效 JSON", {
      reason: error instanceof Error ? error.message : String(error),
    });
  }
  if (value?.version !== 1 || !Array.isArray(value.metrics) || typeof value.environment !== "object") {
    throw new TuiLensError("INVALID_BASELINE", "性能基线文件缺少必需字段或版本不受支持");
  }
  return value;
}

/** 跨轮次合并同名指标的分布；轮次已隔离进程，合并可抵消机器抖动。 */
function mergeRounds(rounds: PerfRound[]): MetricSummary[] {
  const order: string[] = [];
  const buckets = new Map<string, { phase: string; name: string; elapsed: number[]; paint: number[] }>();
  for (const round of rounds) {
    // 只在原始采样缺失时（例如旧报告）退回到聚合值，绝不凭空制造样本。
    const source =
      round.raw ??
      round.metrics.map((metric) => ({
        phase: metric.phase,
        name: metric.name,
        elapsed: metric.elapsedMs.count > 0 ? [metric.elapsedMs.p50] : [],
        ...(metric.paintMs ? { paint: [metric.paintMs.p50] } : {}),
      }));
    for (const item of source) {
      const key = `${item.phase}\u0000${item.name}`;
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = { phase: item.phase, name: item.name, elapsed: [], paint: [] };
        buckets.set(key, bucket);
        order.push(key);
      }
      bucket.elapsed.push(...item.elapsed);
      if (item.paint) bucket.paint.push(...item.paint);
    }
  }
  return order.map((key) => {
    const bucket = buckets.get(key)!;
    return {
      phase: bucket.phase,
      name: bucket.name,
      elapsedMs: summarize(bucket.elapsed),
      ...(bucket.paint.length ? { paintMs: summarize(bucket.paint) } : {}),
      samples: bucket.elapsed.length,
    };
  });
}

async function runSetup(
  manager: SessionManager,
  id: string,
  steps: NonNullable<PerfSpec["phases"][number]["setup"]>,
  sequence: { value: number },
  signal?: AbortSignal
): Promise<void> {
  const control = signal ? { signal } : {};
  for (const step of steps) {
    switch (step.type) {
      case "input":
        sequence.value += 1;
        await manager.input(id, step.action as InputAction, undefined, control);
        break;
      case "resize":
        await manager.resize(id, step.cols, step.rows, control);
        break;
      case "wait":
        await manager.wait(id, {
          conditions: substituteSequence(step.conditions as WaitCondition[], sequence.value),
          ...(step.timeoutMs === undefined ? {} : { timeoutMs: step.timeoutMs }),
          ...control,
        });
        break;
      case "repeat": {
        for (let index = 0; index < step.times; index += 1) {
          sequence.value += 1;
          await manager.inputAndWait(
            id,
            step.input as InputAction,
            undefined,
            {
              ...(step.observe
                ? { conditions: substituteSequence(step.observe as WaitCondition[], sequence.value) }
                : {}),
              ...(step.timeoutMs === undefined ? {} : { timeoutMs: step.timeoutMs }),
            },
            control
          );
        }
        break;
      }
    }
  }
}

/**
 * 单次采样：计时覆盖「输入送达」到「目标条件成立」的实际时间。
 *
 * 超时会让整轮失败而不是产生一个偏大的样本，
 * 因此这里的耗时始终是真实完成的响应时间。
 */
async function measureSample(
  manager: SessionManager,
  session: SessionInfo,
  sample: PerfSample,
  sequence: { value: number },
  measurePaint: boolean,
  signal?: AbortSignal
): Promise<{ elapsed: number; paintMs?: number }> {
  sequence.value += 1;
  const result = await manager.inputAndWait(
    session.id,
    sample.input as InputAction,
    undefined,
    {
      ...(sample.observe ? { conditions: substituteSequence(sample.observe as WaitCondition[], sequence.value) } : {}),
      timeoutMs: sample.timeoutMs ?? 30_000,
    },
    signal ? { signal } : {}
  );
  requireSameRenderer(session.renderer, result.session.renderer);
  const paint = measurePaint ? await manager.paint(session.id, signal ? { signal } : {}) : undefined;
  return {
    elapsed: rounded(result.elapsedMs),
    ...(paint === undefined ? {} : { paintMs: rounded(paint.paintMs) }),
  };
}

function requireSameRenderer(expected: RendererKind | undefined, actual: RendererKind | undefined): void {
  if (expected !== actual) {
    throw new TuiLensError("PERF_ENVIRONMENT_MISMATCH", "采样期间渲染器发生变化，无法合并性能数据", {
      expected,
      actual,
    });
  }
}

/**
 * 把条件里的 `{{seq}}` 替换为序号。
 *
 * 重复采样必须等待「这一次」产生的新证据；固定文本只会在第一次采样时
 * 成立，之后会立即命中，把测量变成噪声。`seq` 按轮次内发送的输入次数递增，
 * 因此要求被等待的证据同样随输入单调变化（例如 `TURN_{{seq}}`）。
 */
function substituteSequence(conditions: WaitCondition[], seq: number): WaitCondition[] {
  return conditions.map((condition) =>
    condition.kind === "text" ? { ...condition, text: condition.text.replaceAll("{{seq}}", String(seq)) } : condition
  );
}
