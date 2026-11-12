import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { errorRecord, TuiLensError } from "../core/errors.js";
import type {
  ClickTextOptions, InputAction, LaunchOptions, RendererKind, WaitCondition,
} from "../core/types.js";
import type { SessionManager } from "../session/manager.js";
import { scenarioSchema, type ScenarioSpec } from "./schema.js";
import type { VisualOptions } from "../visual/artifacts.js";

export interface ScenarioResult {
  pass: boolean;
  reportPath: string;
  terminalProfile?: string;
  renderer?: RendererKind;
  steps: { index: number; type: string; name?: string; elapsedMs: number; result?: unknown; error?: unknown }[];
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
): Promise<ScenarioRunResult> {
  const parsed = scenarioSchema.safeParse(specification);
  if (!parsed.success) throw new TuiLensError("INVALID_SCENARIO", "场景格式不合法", parsed.error.issues);
  const spec = parsed.data;
  if (spec.profiles) return runScenarioMatrix(manager, spec, directory, signal);
  return runScenarioSingle(manager, spec, directory, signal);
}

async function runScenarioMatrix(
  manager: SessionManager,
  spec: ScenarioSpec,
  directory: string,
  signal?: AbortSignal,
): Promise<ScenarioMatrixResult> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const profiles = spec.profiles!;
  const { profiles: _profiles, ...base } = spec;
  const runs: ScenarioResult[] = [];
  for (const profile of profiles) {
    if (signal?.aborted) break;
    runs.push(await runScenarioSingle(manager, {
      ...base,
      launch: { ...base.launch, terminalProfile: profile } as LaunchOptions,
    }, directory, signal));
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
): Promise<ScenarioResult> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const result: ScenarioResult = { pass: true, reportPath: join(directory, `scenario-${randomUUID()}.json`), steps: [] };
  let id: string | undefined;
  try {
    if (signal?.aborted) throw new TuiLensError("ABORTED", "场景已取消");
    const launched = await manager.launch(spec.launch as LaunchOptions);
    id = launched.id;
    if (launched.terminalProfile) result.terminalProfile = launched.terminalProfile;
    if (launched.renderer) result.renderer = launched.renderer;
    for (const [index, step] of spec.steps.entries()) {
      const started = performance.now();
      const record: ScenarioResult["steps"][number] = {
        index, type: step.type, elapsedMs: 0, ...(step.name ? { name: step.name } : {}),
      };
      result.steps.push(record);
      try {
        if (signal?.aborted) throw new TuiLensError("ABORTED", "场景已取消");
        switch (step.type) {
          case "input": await manager.input(id, step.action as InputAction, undefined, signal ? { signal } : {}); break;
          case "resize": await manager.resize(id, step.cols, step.rows, signal ? { signal } : {}); break;
          case "wait": {
            const waited = await manager.wait(id, { conditions: step.conditions as WaitCondition[],
              ...(step.timeoutMs === undefined ? {} : { timeoutMs: step.timeoutMs }), ...(signal ? { signal } : {}) });
            record.result = { frameId: waited.observation.snapshot.frameId };
            break;
          }
          case "observe": {
            const observation = await manager.observe(id, {
              ...(step.region ? { region: step.region } : {}),
              ...(step.cursor ? { cursor: step.cursor } : {}),
            }, signal ? { signal } : {});
            record.result = observation.screenshot;
            break;
          }
          case "clickText": await manager.clickText(id, step.text, step.region, step.options as ClickTextOptions | undefined, signal ? { signal } : {}); break;
          case "compare": {
            const comparison = await manager.compare(id, step.options as VisualOptions, signal ? { signal } : {});
            record.result = comparison;
            if (!comparison.pass) throw new TuiLensError("VISUAL_MISMATCH", "视觉比较超过允许差异", comparison);
          }
        }
      } catch (error) {
        record.error = errorRecord(error);
        throw error;
      } finally { record.elapsedMs = performance.now() - started; }
    }
  } catch (error) {
    result.pass = false;
    if (!result.steps.length) result.steps.push({ index: -1, type: "launch", elapsedMs: 0, error: errorRecord(error) });
    if (id && !signal?.aborted) {
      try {
        const capture = await manager.observe(id, {}, { timeoutMs: 2000 });
        if (capture.screenshot) result.failureScreenshot = capture.screenshot.path;
      } catch (captureError) {
        result.steps.push({ index: -1, type: "failureEvidence", elapsedMs: 0, error: errorRecord(captureError) });
      }
    }
  } finally {
    if (id) {
      try { await manager.close(id); }
      catch (error) { result.pass = false; result.cleanupError = errorRecord(error); }
    }
    await writeFile(result.reportPath, JSON.stringify(result, null, 2), { mode: 0o600 });
  }
  return result;
}
