import { TuiLensError } from "../core/errors.js";
import type { InputAction, InputGuard, LaunchOptions, MatchOptions, Observation, WaitCondition } from "../core/types.js";
import type { VisualOptions } from "../visual/artifacts.js";
import { methodSchemas, type Method } from "../interfaces/schemas.js";
import type { SessionManager } from "../session/manager.js";

export async function dispatch(manager: SessionManager, method: string, params: unknown, signal: AbortSignal): Promise<unknown> {
  if (!Object.hasOwn(methodSchemas, method)) throw new TuiLensError("UNKNOWN_METHOD", "未知命令");
  const result = methodSchemas[method as Method].safeParse(params);
  if (!result.success) throw new TuiLensError("INVALID_ARGUMENT", "命令参数不合法", result.error.issues);
  switch (method) {
    case "ping": return { version: "0.2.0", pid: process.pid };
    case "launch": {
      const session = await manager.launch(result.data as LaunchOptions);
      // 客户端取消启动时不得留下无法返回 ID 的孤儿会话。
      if (signal.aborted) {
        await manager.close(session.id);
        throw new TuiLensError("ABORTED", "启动已取消");
      }
      return session;
    }
    case "list": return manager.list();
    case "metrics": return manager.metrics(methodSchemas.metrics.parse(result.data).id);
    case "find": {
      const args = methodSchemas.find.parse(result.data);
      return manager.find(args.id, args.text, args.region, { signal }, args.options as MatchOptions | undefined);
    }
    case "clickText": {
      const args = methodSchemas.clickText.parse(result.data);
      return manager.clickText(args.id, args.text, args.region, args.options as MatchOptions | undefined, { signal });
    }
    case "observe": {
      const args = methodSchemas.observe.parse(result.data);
      return presentObservation(await manager.observe(args.id, {
        ...(args.screenshot === undefined ? {} : { screenshot: args.screenshot }),
        ...(args.region ? { region: args.region } : {}),
      }, { signal }), args.includeCells ?? false);
    }
    case "input": {
      const args = methodSchemas.input.parse(result.data);
      await manager.input(args.id, args.action as InputAction, args.guard as InputGuard | undefined, { signal });
      return { accepted: true };
    }
    case "resize": {
      const args = methodSchemas.resize.parse(result.data);
      await manager.resize(args.id, args.cols, args.rows, { signal });
      return { resized: true };
    }
    case "wait": {
      const args = methodSchemas.wait.parse(result.data);
      const waited = await manager.wait(args.id, { conditions: args.conditions as WaitCondition[], signal,
        ...(args.afterFrameId === undefined ? {} : { afterFrameId: args.afterFrameId }),
        ...(args.timeoutMs === undefined ? {} : { timeoutMs: args.timeoutMs }) });
      return { ...waited, observation: presentObservation(waited.observation, false) };
    }
    case "compare": {
      const args = methodSchemas.compare.parse(result.data);
      return manager.compare(args.id, args.options as VisualOptions, { signal });
    }
    case "replay": {
      const args = methodSchemas.replay.parse(result.data);
      const replayed = await manager.replay(args.path, { signal,
        ...(args.speed === undefined ? {} : { speed: args.speed }),
        ...(args.allowTruncated === undefined ? {} : { allowTruncated: args.allowTruncated }),
      });
      const { cells: _cells, ...snapshot } = replayed.snapshot;
      return { ...replayed, snapshot };
    }
    case "scenario": return manager.scenario(methodSchemas.scenario.parse(result.data).specification, signal);
    case "close": {
      await manager.close(methodSchemas.close.parse(result.data).id);
      return { closed: true };
    }
    case "shutdown": await manager.closeAll(); return { stopped: true };
    default: throw new TuiLensError("UNKNOWN_METHOD", "未知命令");
  }
}

/** 默认只回传可读画面；数千字符格可按需请求，完整证据仍保存在 JSON 文件。 */
function presentObservation(observation: Observation, includeCells: boolean) {
  if (includeCells) return observation;
  const { cells: _cells, ...snapshot } = observation.snapshot;
  return { ...observation, snapshot };
}
