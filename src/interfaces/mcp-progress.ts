import type { OperationProgress } from "../core/types.js";

export const MAX_MCP_PROGRESS_EVENTS = 100;
export const MCP_PROGRESS_INTERVAL_MS = 100;

export type ProgressSink = (progress: OperationProgress) => void;

/**
 * Daemon progress is already bounded for wait/inputAndWait/replay, but scenario/perf can emit one
 * event per step and profile. Coalesce those events into at most 100 real notifications and keep the
 * latest value for the final flush.
 */
export class McpProgressForwarder {
  private readonly lastByStream = new Map<string, number>();
  private lastSentKey = "";
  private latest: OperationProgress | undefined;
  private emitted = 0;
  private lastSentAt = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly send: ProgressSink,
    private readonly now: () => number = () => performance.now(),
    private readonly intervalMs = MCP_PROGRESS_INTERVAL_MS,
    private readonly maxEvents = MAX_MCP_PROGRESS_EVENTS
  ) {
    if (!Number.isFinite(intervalMs) || intervalMs < 0) {
      throw new RangeError("MCP progress interval must be a non-negative finite number");
    }
    if (!Number.isInteger(maxEvents) || maxEvents < 1) {
      throw new RangeError("MCP progress limit must be a positive integer");
    }
  }

  offer(progress: OperationProgress): void {
    const stream = `${progress.kind}\0${progress.profile ?? ""}\0${progress.total}`;
    const previous = this.lastByStream.get(stream);
    if (previous !== undefined && progress.current < previous) return;
    this.lastByStream.set(stream, progress.current);
    this.latest = progress;
    // Keep one slot for finish() so a long operation always reports its latest real state.
    if (this.emitted >= this.maxEvents - 1) return;
    if (progressKey(progress) === this.lastSentKey) return;
    const now = this.now();
    if (this.emitted > 0 && now - this.lastSentAt < this.intervalMs) return;
    this.flush(progress, now);
  }

  finish(): void {
    if (!this.latest || this.emitted >= this.maxEvents) return;
    if (progressKey(this.latest) === this.lastSentKey) return;
    this.flush(this.latest, this.now());
  }

  private flush(progress: OperationProgress, now: number): void {
    this.emitted += 1;
    this.lastSentAt = now;
    this.lastSentKey = progressKey(progress);
    this.send(progress);
  }
}

function progressKey(progress: OperationProgress): string {
  return `${progress.kind}\0${progress.profile ?? ""}\0${progress.total}\0${progress.current}`;
}
