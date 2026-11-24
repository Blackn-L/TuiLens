import { TuiLensError } from "../core/errors.js";
import type {
  ClickTextOptions,
  InputAction,
  InputGuard,
  LaunchOptions,
  MatchOptions,
  Observation,
  WaitCondition,
} from "../core/types.js";
import type { VisualOptions } from "../visual/artifacts.js";
import { methodSchemas, type Method } from "../interfaces/schemas.js";
import type { SessionManager } from "../session/manager.js";
import { VERSION } from "../version.js";
import type { z } from "zod";

type Params<M extends Method> = z.infer<(typeof methodSchemas)[M]>;
export type DispatchEmit = (event: "progress" | "frame" | "exit", data: unknown) => void;

export async function dispatch(
  manager: SessionManager,
  method: string,
  params: unknown,
  signal: AbortSignal,
  emit: DispatchEmit = () => {}
): Promise<unknown> {
  if (!Object.hasOwn(methodSchemas, method)) throw new TuiLensError("UNKNOWN_METHOD", "未知命令");
  const result = methodSchemas[method as Method].safeParse(params);
  if (!result.success) throw new TuiLensError("INVALID_ARGUMENT", "命令参数不合法", result.error.issues);
  switch (method) {
    case "ping":
      return {
        version: VERSION,
        pid: process.pid,
        uptimeMs: Math.round(process.uptime() * 1000),
        ...manager.runtimeStats(),
      };
    case "launch": {
      const session = await manager.launch(result.data as LaunchOptions);
      // 客户端取消启动时不得留下无法返回 ID 的孤儿会话。
      if (signal.aborted) {
        await manager.close(session.id);
        throw new TuiLensError("ABORTED", "启动已取消");
      }
      return session;
    }
    case "list":
      return manager.list();
    case "metrics":
      return manager.metrics((result.data as Params<"metrics">).id);
    case "find": {
      const args = result.data as Params<"find">;
      return manager.find(args.id, args.text, args.region, { signal }, args.options as MatchOptions | undefined);
    }
    case "clickText": {
      const args = result.data as Params<"clickText">;
      return manager.clickText(args.id, args.text, args.region, args.options as ClickTextOptions | undefined, {
        signal,
      });
    }
    case "observe": {
      const args = result.data as Params<"observe">;
      // 未请求字符格时在引擎侧就不构造网格，而不是传完整网格后再剥离。
      return presentObservation(
        await manager.observe(
          args.id,
          {
            cells: args.includeCells === true,
            ...(args.compact === undefined ? {} : { compact: args.compact }),
            ...(args.screenshot === undefined ? {} : { screenshot: args.screenshot }),
            ...(args.region ? { region: args.region } : {}),
            ...(args.scrollback === undefined ? {} : { scrollback: args.scrollback }),
            ...(args.cursor ? { cursor: args.cursor } : {}),
          },
          { signal }
        ),
        args.includeCells ?? false
      );
    }
    case "watch": {
      const args = result.data as Params<"watch">;
      return manager.watch(
        args.id,
        args.intervalMs,
        { signal },
        (event, data) => {
          emit(event, event === "frame" ? presentObservation(data as Observation, false) : data);
        },
        args.timeoutMs
      );
    }
    case "input": {
      const args = result.data as Params<"input">;
      await manager.input(args.id, args.action as InputAction, args.guard as InputGuard | undefined, { signal });
      return { accepted: true };
    }
    case "inputAndWait": {
      const args = result.data as Params<"inputAndWait">;
      const waited = await manager.inputAndWait(
        args.id,
        args.action as InputAction,
        args.guard as InputGuard | undefined,
        {
          ...(args.wait?.conditions ? { conditions: args.wait.conditions as WaitCondition[] } : {}),
          ...(args.wait?.timeoutMs === undefined ? {} : { timeoutMs: args.wait.timeoutMs }),
        },
        { signal },
        args.screenshot ?? false
      );
      return { ...waited, observation: presentObservation(waited.observation, false) };
    }
    case "resize": {
      const args = result.data as Params<"resize">;
      await manager.resize(args.id, args.cols, args.rows, { signal });
      return { resized: true };
    }
    case "wait": {
      const args = result.data as Params<"wait">;
      const waited = await manager.wait(args.id, {
        conditions: args.conditions as WaitCondition[],
        signal,
        ...(args.afterFrameId === undefined ? {} : { afterFrameId: args.afterFrameId }),
        ...(args.timeoutMs === undefined ? {} : { timeoutMs: args.timeoutMs }),
      });
      return { ...waited, observation: presentObservation(waited.observation, false) };
    }
    case "compare": {
      const args = result.data as Params<"compare">;
      return manager.compare(args.id, args.options as VisualOptions, { signal });
    }
    case "replay": {
      const args = result.data as Params<"replay">;
      const replayed = await manager.replay(args.path, {
        signal,
        ...(args.speed === undefined ? {} : { speed: args.speed }),
        ...(args.allowTruncated === undefined ? {} : { allowTruncated: args.allowTruncated }),
      });
      const { cells: _cells, ...snapshot } = replayed.snapshot;
      return { ...replayed, snapshot };
    }
    case "scenario":
      return manager.scenario((result.data as Params<"scenario">).specification, signal, (progress) =>
        emit("progress", progress)
      );
    case "perf": {
      const args = result.data as Params<"perf">;
      return manager.perf({
        spec: args.specification,
        signal,
        onProgress: (progress) => emit("progress", progress),
        ...(args.baseline ? { baseline: args.baseline } : {}),
        ...(args.writeBaseline ? { writeBaseline: args.writeBaseline } : {}),
        ...(args.maxRegression === undefined ? {} : { maxRegression: args.maxRegression }),
        ...(args.allowEnvironmentMismatch === undefined
          ? {}
          : { allowEnvironmentMismatch: args.allowEnvironmentMismatch }),
      });
    }
    case "close": {
      await manager.close((result.data as Params<"close">).id);
      return { closed: true };
    }
    case "shutdown":
      await manager.closeAll();
      return { stopped: true };
    default:
      throw new TuiLensError("UNKNOWN_METHOD", "未知命令");
  }
}

/** 默认只回传可读画面；数千字符格可按需请求，完整证据仍保存在 JSON 文件。 */
function presentObservation(observation: Observation, includeCells: boolean) {
  if (includeCells) return observation;
  const { cells: _cells, ...snapshot } = observation.snapshot;
  return { ...observation, snapshot };
}
