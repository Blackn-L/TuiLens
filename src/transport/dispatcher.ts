import { randomUUID } from "node:crypto";
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
  emit: DispatchEmit = () => {},
  ownerId?: string,
  requestId: string = randomUUID()
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
      const session = await manager.launch(result.data as LaunchOptions, ownerId, requestId);
      // 客户端取消启动时不得留下无法返回 ID 的孤儿会话。
      if (signal.aborted) {
        await manager.releaseAcquisition(session.id, requestId, ownerId);
        throw new TuiLensError("ABORTED", "启动已取消");
      }
      return session;
    }
    case "list":
      return manager.listOwned(ownerId, (result.data as Params<"list">).includeAll);
    case "replay": {
      const args = result.data as Params<"replay">;
      const replayed = await manager.replay(args.path, {
        signal,
        onProgress: (progress) => emit("progress", progress),
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
    case "handoff":
      return manager.handoff((result.data as Params<"handoff">).id, ownerId);
    case "adopt": {
      if (signal.aborted) throw new TuiLensError("ABORTED", "会话接管已取消");
      const { id, token } = result.data as Params<"adopt">;
      return manager.adopt(id, token, ownerId, requestId);
    }
    case "releaseOwned":
    case "releaseAcquisition": {
      if (ownerId === undefined) {
        throw new TuiLensError(
          "UNAUTHORIZED",
          "仅有独立归属的连接可释放其会话",
          undefined,
          "A scoped connection is required to release owned sessions."
        );
      }
      if (method === "releaseAcquisition") {
        const { id, acquisitionId } = result.data as Params<"releaseAcquisition">;
        return { released: await manager.releaseAcquisition(id, acquisitionId, ownerId) };
      }
      return { released: await manager.releaseOwned(ownerId) };
    }
    case "close": {
      await manager.closeOwned((result.data as Params<"close">).id, ownerId);
      return { closed: true };
    }
    case "shutdown":
      if (ownerId !== undefined) {
        throw new TuiLensError(
          "UNAUTHORIZED",
          "仅本机 CLI 可关闭守护进程",
          undefined,
          "Only the local CLI can shut down the daemon."
        );
      }
      await manager.closeAll();
      return { stopped: true };
  }
  if (!("id" in result.data) || result.data.id === undefined) throw new TuiLensError("UNKNOWN_METHOD", "未知命令");
  return manager.withOwnedSession(result.data.id, ownerId, () =>
    runSessionMethod(manager, method, result.data, signal, emit)
  );
}

// Every ID-based operation holds its owner check until its final response is ready.
async function runSessionMethod(
  manager: SessionManager,
  method: string,
  data: Params<Method>,
  signal: AbortSignal,
  emit: DispatchEmit
): Promise<unknown> {
  switch (method) {
    case "metrics":
      return manager.metrics((data as Params<"metrics">).id);
    case "find": {
      const args = data as Params<"find">;
      return manager.find(args.id, args.text, args.region, { signal }, args.options as MatchOptions | undefined);
    }
    case "clickText": {
      const args = data as Params<"clickText">;
      return manager.clickText(args.id, args.text, args.region, args.options as ClickTextOptions | undefined, {
        signal,
      });
    }
    case "observe": {
      const args = data as Params<"observe">;
      const view = args.view ?? "compact";
      return presentObservation(
        await manager.observe(
          args.id,
          {
            view,
            ...(args.fromFrameId === undefined ? {} : { fromFrameId: args.fromFrameId }),
            ...(args.screenshot === undefined ? {} : { screenshot: args.screenshot }),
            ...(args.region ? { region: args.region } : {}),
            ...(args.scrollback === undefined ? {} : { scrollback: args.scrollback }),
            ...(args.cursor ? { cursor: args.cursor } : {}),
          },
          { signal }
        ),
        view === "cells"
      );
    }
    case "watch": {
      const args = data as Params<"watch">;
      return manager.watch(
        args.id,
        args.intervalMs,
        { signal },
        (event, data) => emit(event, event === "frame" ? presentObservation(data as Observation, false) : data),
        args.timeoutMs
      );
    }
    case "input": {
      const args = data as Params<"input">;
      await manager.input(args.id, args.action as InputAction, args.guard as InputGuard | undefined, { signal });
      return { accepted: true };
    }
    case "inputAndWait": {
      const args = data as Params<"inputAndWait">;
      const waited = await manager.inputAndWait(
        args.id,
        args.action as InputAction,
        args.guard as InputGuard | undefined,
        {
          ...(args.wait?.conditions ? { conditions: args.wait.conditions as WaitCondition[] } : {}),
          ...(args.wait?.timeoutMs === undefined ? {} : { timeoutMs: args.wait.timeoutMs }),
          onProgress: (progress) => emit("progress", progress),
        },
        { signal },
        args.screenshot ?? false
      );
      return { ...waited, observation: presentObservation(waited.observation, false) };
    }
    case "resize": {
      const args = data as Params<"resize">;
      await manager.resize(args.id, args.cols, args.rows, { signal });
      return { resized: true };
    }
    case "wait": {
      const args = data as Params<"wait">;
      const waited = await manager.wait(args.id, {
        conditions: args.conditions as WaitCondition[],
        signal,
        onProgress: (progress) => emit("progress", progress),
        ...(args.afterFrameId === undefined ? {} : { afterFrameId: args.afterFrameId }),
        ...(args.timeoutMs === undefined ? {} : { timeoutMs: args.timeoutMs }),
      });
      return { ...waited, observation: presentObservation(waited.observation, false) };
    }
    case "compare": {
      const args = data as Params<"compare">;
      return manager.compare(args.id, args.options as VisualOptions, { signal });
    }
    default:
      throw new TuiLensError("UNKNOWN_METHOD", "未知命令");
  }
}

/** Omit cell arrays from every view except explicit cells observations. */
function presentObservation(observation: Observation, includeCells: boolean) {
  if (includeCells) return observation;
  const { cells: _cells, ...snapshot } = observation.snapshot;
  return { ...observation, snapshot };
}
