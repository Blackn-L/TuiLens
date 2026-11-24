import type { OperationProgress, ProgressReporter } from "./types.js";

/** 长任务进度最多发送 100 条，避免慢速轮询或超大录制无限刷通知。 */
export const MAX_PROGRESS_EVENTS = 100;
const DEFAULT_PROGRESS_INTERVAL_MS = 100;

export type ProgressEmitter = (current: number, elapsedMs: number, force?: boolean) => void;

/** 只在真实状态推进时上报；节流并保证 current 单调不减。 */
export function progressEmitter(
  kind: OperationProgress["kind"],
  total: number,
  onProgress: ProgressReporter | undefined,
  intervalMs = DEFAULT_PROGRESS_INTERVAL_MS
): ProgressEmitter {
  if (!onProgress) return () => {};
  const boundedTotal = Math.max(1, Math.round(total));
  let lastAt = Number.NEGATIVE_INFINITY;
  let lastCurrent = -1;
  let emitted = 0;
  return (current, elapsedMs, force = false) => {
    const boundedCurrent = Math.max(0, Math.min(boundedTotal, Math.round(current)));
    if (emitted >= (force ? MAX_PROGRESS_EVENTS : MAX_PROGRESS_EVENTS - 1)) return;
    if (!force && elapsedMs - lastAt < intervalMs) return;
    if (boundedCurrent < lastCurrent) return;
    lastAt = elapsedMs;
    lastCurrent = boundedCurrent;
    emitted += 1;
    onProgress({
      kind,
      current: boundedCurrent,
      total: boundedTotal,
      elapsedMs,
    });
  };
}
