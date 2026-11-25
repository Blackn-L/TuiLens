import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { errorRecord, TuiLensError } from "../core/errors.js";
import type {
  ClickTextOptions,
  InputAction,
  LaunchOptions,
  ProgressReporter,
  RendererKind,
  WaitCondition,
} from "../core/types.js";
import type { SessionManager } from "../session/manager.js";
import { scenarioSchema, type ScenarioSpec } from "./schema.js";
import type { VisualOptions } from "../visual/artifacts.js";

export interface ScenarioResult {
  pass: boolean;
  reportPath: string;
  cols?: number;
  rows?: number;
  terminalProfile?: string;
  renderer?: RendererKind;
  steps: {
    index: number;
    type: string;
    name?: string;
    detail?: string;
    elapsedMs: number;
    result?: unknown;
    error?: unknown;
  }[];
  failureScreenshot?: string;
  cleanupError?: unknown;
}

export interface ScenarioMatrixResult {
  pass: boolean;
  matrix: true;
  reportPath: string;
  profiles: string[];
  runs: ScenarioResult[];
}

export type ScenarioRunResult = ScenarioResult | ScenarioMatrixResult;

/** 声明式步骤只调用公开会话接口。每次失败保存证据，始终回收本次启动的进程。 */
export async function runScenario(
  manager: SessionManager,
  specification: unknown,
  directory: string,
  signal?: AbortSignal,
  onProgress?: ProgressReporter
): Promise<ScenarioRunResult> {
  const parsed = scenarioSchema.safeParse(specification);
  if (!parsed.success) throw new TuiLensError("INVALID_SCENARIO", "场景格式不合法", parsed.error.issues);
  const spec = parsed.data;
  if (spec.profiles) return runScenarioMatrix(manager, spec, directory, signal, onProgress);
  return runScenarioSingle(manager, spec, directory, signal, onProgress);
}

async function runScenarioMatrix(
  manager: SessionManager,
  spec: ScenarioSpec,
  directory: string,
  signal?: AbortSignal,
  onProgress?: ProgressReporter
): Promise<ScenarioMatrixResult> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const profiles = spec.profiles!;
  const { profiles: _profiles, ...base } = spec;
  const runs: ScenarioResult[] = [];
  for (const profile of profiles) {
    if (signal?.aborted) break;
    const report = onProgress
      ? (progress: Parameters<ProgressReporter>[0]) => onProgress({ ...progress, profile })
      : undefined;
    runs.push(
      await runScenarioSingle(
        manager,
        {
          ...base,
          launch: { ...base.launch, terminalProfile: profile } as LaunchOptions,
        },
        directory,
        signal,
        report
      )
    );
  }
  const result: ScenarioMatrixResult = {
    pass: runs.length === profiles.length && runs.every((run) => run.pass),
    matrix: true,
    reportPath: join(directory, `scenario-matrix-${randomUUID()}.json`),
    profiles: [...profiles],
    runs,
  };
  await writeFile(result.reportPath, JSON.stringify(result, null, 2), { mode: 0o600 });
  return result;
}

async function runScenarioSingle(
  manager: SessionManager,
  spec: ScenarioSpec,
  directory: string,
  signal?: AbortSignal,
  onProgress?: ProgressReporter
): Promise<ScenarioResult> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const result: ScenarioResult = {
    pass: true,
    reportPath: join(directory, `scenario-${randomUUID()}.json`),
    steps: [],
  };
  let id: string | undefined;
  const scenarioStarted = performance.now();
  try {
    if (signal?.aborted) throw new TuiLensError("ABORTED", "场景已取消");
    const launched = await manager.launch(spec.launch as LaunchOptions);
    id = launched.id;
    result.cols = launched.cols;
    result.rows = launched.rows;
    if (launched.terminalProfile) result.terminalProfile = launched.terminalProfile;
    if (launched.renderer) result.renderer = launched.renderer;
    for (const [index, step] of spec.steps.entries()) {
      const started = performance.now();
      const record: ScenarioResult["steps"][number] = {
        index,
        type: step.type,
        elapsedMs: 0,
        detail: describeStep(step),
        ...(step.name ? { name: step.name } : {}),
      };
      result.steps.push(record);
      try {
        if (signal?.aborted) throw new TuiLensError("ABORTED", "场景已取消");
        switch (step.type) {
          case "input":
            await manager.input(id, step.action as InputAction, undefined, signal ? { signal } : {});
            break;
          case "resize":
            await manager.resize(id, step.cols, step.rows, signal ? { signal } : {});
            break;
          case "wait": {
            const waited = await manager.wait(id, {
              conditions: step.conditions as WaitCondition[],
              ...(step.timeoutMs === undefined ? {} : { timeoutMs: step.timeoutMs }),
              ...(signal ? { signal } : {}),
            });
            record.result = { frameId: waited.observation.snapshot.frameId };
            break;
          }
          case "observe": {
            const observation = await manager.observe(
              id,
              {
                view: "compact",
                screenshot: true,
                ...(step.region ? { region: step.region } : {}),
                ...(step.cursor ? { cursor: step.cursor } : {}),
              },
              signal ? { signal } : {}
            );
            record.result = observation.screenshot;
            break;
          }
          case "clickText":
            await manager.clickText(
              id,
              step.text,
              step.region,
              step.options as ClickTextOptions | undefined,
              signal ? { signal } : {}
            );
            break;
          case "compare": {
            const comparison = await manager.compare(id, step.options as VisualOptions, signal ? { signal } : {});
            record.result = comparison;
            if (!comparison.pass) throw new TuiLensError("VISUAL_MISMATCH", "视觉比较超过允许差异", comparison);
          }
        }
      } catch (error) {
        record.error = errorRecord(error);
        throw error;
      } finally {
        record.elapsedMs = performance.now() - started;
        onProgress?.({
          kind: "scenario",
          ...(result.terminalProfile ? { profile: result.terminalProfile } : {}),
          current: index + 1,
          total: spec.steps.length,
          elapsedMs: Math.round(performance.now() - scenarioStarted),
        });
      }
    }
  } catch (error) {
    result.pass = false;
    if (!result.steps.length) result.steps.push({ index: -1, type: "launch", elapsedMs: 0, error: errorRecord(error) });
    if (id && !signal?.aborted) {
      try {
        const capture = await manager.observe(id, { view: "compact", screenshot: true }, { timeoutMs: 5000 });
        if (capture.screenshot) result.failureScreenshot = capture.screenshot.path;
      } catch (captureError) {
        result.steps.push({ index: -1, type: "failureEvidence", elapsedMs: 0, error: errorRecord(captureError) });
      }
    }
  } finally {
    if (id) {
      const current = manager.list().find((session) => session.id === id);
      if (current?.renderer) result.renderer = current.renderer;
      try {
        await manager.close(id);
      } catch (error) {
        result.pass = false;
        result.cleanupError = errorRecord(error);
      }
    }
    await writeFile(result.reportPath, JSON.stringify(result, null, 2), { mode: 0o600 });
  }
  return result;
}

function describeStep(step: ScenarioSpec["steps"][number]): string {
  const value = (() => {
    switch (step.type) {
      case "input": {
        const action = step.action as InputAction & { text?: string; key?: string; x?: number; y?: number };
        const target = action.text ?? action.key ?? "";
        return `input ${action.type}${target ? ` ${JSON.stringify(target.slice(0, 80))}` : ""}`;
      }
      case "resize":
        return `resize ${step.cols}x${step.rows}`;
      case "wait":
        return `wait ${step.conditions.map(describeCondition).join(" AND ")}`;
      case "observe":
        return `observe ${step.region ? `region ${step.region.x},${step.region.y},${step.region.width},${step.region.height}` : "full view"}${step.cursor ? ` cursor=${step.cursor}` : ""}`;
      case "clickText":
        return `clickText ${JSON.stringify(step.text.slice(0, 80))}`;
      case "compare":
        return `compare ${step.options.baseline}`;
    }
  })();
  return value.length <= 1000 ? value : `${value.slice(0, 997)}...`;
}

type ScenarioCondition = Extract<ScenarioSpec["steps"][number], { type: "wait" }>["conditions"][number];

function describeCondition(condition: ScenarioCondition): string {
  if (condition.kind === "text") {
    return `text ${JSON.stringify(condition.text.slice(0, 80))}${condition.absent ? " absent" : ""}`;
  }
  if (condition.kind === "size") return `size ${condition.cols}x${condition.rows}`;
  if (condition.kind === "stable") return `stable ${condition.durationMs ?? 250}ms`;
  if (condition.kind === "cursor") return "cursor";
  return "exited";
}
