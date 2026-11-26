import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { IDisposable } from "node-pty";
import { TuiLensError } from "../core/errors.js";
import { compactSnapshot } from "../core/compact.js";
import { diffSnapshots, snapshotLineCells } from "../core/diff.js";
import { encodeInput, encodeScrollBatches } from "../core/input.js";
import type {
  CursorState,
  InputAction,
  InputGuard,
  Observation,
  ObserveOptions,
  ObserveView,
  SessionInfo,
  SnapshotDiff,
  SnapshotFrame,
  TerminalEngine,
  TerminalSnapshot,
  FrameAccessOptions,
  MatchStyle,
  Region,
  ResolvedTerminalProfile,
  TextProbe,
} from "../core/types.js";
import { dimensions, inputGuard, regionWithin } from "../core/validation.js";
import { regionFingerprint } from "../core/locator.js";
import type { RecordingWriter } from "../recording/writer.js";
import { ProtocolReplyGuard, rewriteTerminalProfileReplies, type ProtocolRepliesOptions } from "./protocol-replies.js";
import type { PtyHandle } from "./pty-runtime.js";

const MAX_PENDING_BYTES = 16 * 1024 * 1024;
const MAX_BATCH_CHARS = 32 * 1024;
const MAX_SESSION_SUBSCRIBERS = 16;
const MAX_SUBSCRIBER_COALESCE_MS = 60_000;
export const MAX_FRAME_HISTORY = 16;

export interface SessionFrameEvent {
  type: "frame";
  frameId: number;
  session: SessionInfo;
}

export interface SessionExitEvent {
  type: "exit";
  session: SessionInfo;
  exitCode?: number;
}

export type SessionEvent = SessionFrameEvent | SessionExitEvent;
export type SessionEventSubscriber = (event: SessionEvent) => void;

export interface SessionSubscription {
  dispose(): void;
}

export interface WatchResult {
  frames: number;
  timedOut: boolean;
}

interface SubscriberState {
  listener: SessionEventSubscriber;
  coalesceMs: number;
  timer: NodeJS.Timeout | null;
  latestFrame: SessionFrameEvent | null;
}

export interface SessionMetrics {
  receivedBytes: number;
  appliedBytes: number;
  pendingBytes: number;
  peakPendingBytes: number;
  pauseCount: number;
  pauseDurationMs: number;
  writeBatches: number;
  protocolQueries: number;
  protocolRepliesForwarded: number;
  protocolRepliesDropped: number;
  lastProtocolReplyLatencyMs: number;
}

export interface OperationControl {
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** 取消只取消调用者的等待；已经进入引擎的写入不能回滚，队列仍保持顺序。 */
export function controlled<T>(promise: Promise<T>, control: OperationControl, code = "OPERATION_TIMEOUT"): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let timer: NodeJS.Timeout | undefined;
    let finished = false;
    const cleanup = () => {
      clearTimeout(timer);
      control.signal?.removeEventListener("abort", abort);
    };
    const fail = (error: unknown) => {
      if (finished) return;
      finished = true;
      cleanup();
      reject(error);
    };
    const abort = () => fail(new TuiLensError("ABORTED", "操作已取消"));
    if (control.signal?.aborted) {
      fail(new TuiLensError("ABORTED", "操作已取消"));
      void promise.catch(() => undefined);
      return;
    }
    control.signal?.addEventListener("abort", abort, { once: true });
    if (control.timeoutMs !== undefined) {
      timer = setTimeout(() => fail(new TuiLensError(code, "操作未在期限内完成")), control.timeoutMs);
    }
    promise.then((value) => {
      if (finished) return;
      finished = true;
      cleanup();
      resolve(value);
    }, fail);
  });
}

/** 单会话串行屏障：浏览器状态读取和截图之间不接纳新的终端写入。 */
export class ManagedSession {
  private tail: Promise<void> = Promise.resolve();
  private fault: Error | undefined;
  private frameId = 0;
  private observationId = 0;
  private batch: string[] = [];
  private batchChars = 0;
  private batchBytes = 0;
  private batchTimer: NodeJS.Immediate | undefined;
  private pausedAt: number | undefined;
  private closing = false;
  private closePromise: Promise<void> | undefined;
  private disposables: IDisposable[] = [];
  private readonly exitPromise: Promise<void>;
  private resolveExit: () => void = () => {};
  private readonly exitWaiters = new Set<() => void>();
  private readonly subscribers = new Set<SubscriberState>();
  private readonly frameHistory = new Map<number, SnapshotFrame>();
  private exitPublished = false;
  private readonly closeController = new AbortController();
  private exited = false;
  private readonly protocolGuard: ProtocolReplyGuard;
  private readonly counters: SessionMetrics = {
    receivedBytes: 0,
    appliedBytes: 0,
    pendingBytes: 0,
    peakPendingBytes: 0,
    pauseCount: 0,
    pauseDurationMs: 0,
    writeBatches: 0,
    protocolQueries: 0,
    protocolRepliesForwarded: 0,
    protocolRepliesDropped: 0,
    lastProtocolReplyLatencyMs: 0,
  };

  constructor(
    private readonly details: SessionInfo,
    private readonly engine: TerminalEngine,
    private readonly pty: PtyHandle,
    private readonly artifactDir: string,
    private readonly recorder?: RecordingWriter,
    protocolReplies?: ProtocolRepliesOptions,
    private readonly profile?: ResolvedTerminalProfile
  ) {
    this.protocolGuard = new ProtocolReplyGuard(protocolReplies);
    this.exitPromise = new Promise((resolve) => {
      this.resolveExit = resolve;
    });
    this.disposables.push(pty.onData((data) => this.receive(data)));
    this.disposables.push(
      pty.onExit(({ exitCode }) => {
        this.exited = true;
        this.resolveExit();
        // 最后一批输出先入队；已退出状态只能在它完成后对外可见。
        this.sealBatch();
        void this.enqueue(async () => {
          this.details.status = "exited";
          this.details.exitCode = exitCode;
          try {
            await this.recorder?.append({ type: "exit", code: exitCode });
            await this.recorder?.close();
          } finally {
            this.publishExit();
            for (const wake of [...this.exitWaiters]) wake();
          }
        }).catch((error: unknown) => this.setFault(error));
      })
    );
  }

  info(): SessionInfo {
    return {
      ...this.details,
      ...(this.engine.renderer ? { renderer: this.engine.renderer } : {}),
      ...(this.engine.visualSyncDegraded ? { visualSyncDegraded: true } : {}),
    };
  }

  metrics(): SessionMetrics {
    return {
      ...this.counters,
      ...this.protocolGuard.metrics(),
      pauseDurationMs:
        this.counters.pauseDurationMs + (this.pausedAt === undefined ? 0 : performance.now() - this.pausedAt),
    };
  }

  private rememberFrame(snapshot: TerminalSnapshot, lineCells: Map<number, readonly string[]>): SnapshotFrame {
    const lines = snapshot.lines.map((line) => line.replace(/[ \t]+$/u, ""));
    // Custom engines may already supply a grid; retain only the text columns required for Unicode diffs.
    for (const [y, row] of snapshot.cells.entries()) {
      if (!row.length || lineCells.has(y) || !/[^\x00-\x7f]/u.test(lines[y] ?? "")) continue;
      const columns = row.map((cell) => (cell.width === 0 ? "" : cell.text || " "));
      while (columns.at(-1) === " ") columns.pop();
      lineCells.set(y, columns);
    }
    const frame: SnapshotFrame = {
      frameId: snapshot.frameId,
      cols: snapshot.cols,
      rows: snapshot.rows,
      lines,
      ...(lineCells.size ? { lineCells } : {}),
      cursor: { ...snapshot.cursor },
      modes: {
        ...snapshot.modes,
        ...(snapshot.modes.keyboard ? { keyboard: { ...snapshot.modes.keyboard } } : {}),
      },
    };
    this.frameHistory.delete(frame.frameId);
    this.frameHistory.set(frame.frameId, frame);
    while (this.frameHistory.size > MAX_FRAME_HISTORY) {
      const oldest = this.frameHistory.keys().next().value;
      if (oldest === undefined) break;
      this.frameHistory.delete(oldest);
    }
    return frame;
  }

  /**
   * 订阅器只保留最新帧通知，不排队历史输出；高频写入在 coalesceMs 内合并，
   * 退出事件立即发送。调用方必须在不再观察时 dispose。
   */
  subscribe(listener: SessionEventSubscriber, options: { coalesceMs?: number } = {}): SessionSubscription {
    if (this.subscribers.size >= MAX_SESSION_SUBSCRIBERS) {
      throw new TuiLensError("SESSION_SUBSCRIBER_LIMIT", "会话事件订阅者已达到上限");
    }
    const coalesceMs = options.coalesceMs ?? 16;
    if (!Number.isInteger(coalesceMs) || coalesceMs < 0 || coalesceMs > MAX_SUBSCRIBER_COALESCE_MS) {
      throw new TuiLensError("INVALID_ARGUMENT", `订阅合并窗口必须是 0～${MAX_SUBSCRIBER_COALESCE_MS} ms 的整数`);
    }
    const state: SubscriberState = { listener, coalesceMs, timer: null, latestFrame: null };
    this.subscribers.add(state);
    return {
      dispose: () => {
        if (state.timer) clearTimeout(state.timer);
        state.timer = null;
        state.latestFrame = null;
        this.subscribers.delete(state);
      },
    };
  }

  private publishFrame(): void {
    if (!this.subscribers.size) return;
    const event: SessionFrameEvent = {
      type: "frame",
      frameId: this.frameId,
      session: this.info(),
    };
    for (const subscriber of this.subscribers) {
      subscriber.latestFrame = event;
      if (subscriber.timer) continue;
      subscriber.timer = setTimeout(
        () => {
          subscriber.timer = null;
          const frame = subscriber.latestFrame;
          subscriber.latestFrame = null;
          if (frame && this.subscribers.has(subscriber)) {
            try {
              subscriber.listener(frame);
            } catch {
              // 订阅器异常不能破坏会话写入或服务端连接。
            }
          }
        },
        Math.max(1, subscriber.coalesceMs)
      );
    }
  }

  private publishExit(): void {
    if (this.exitPublished) return;
    this.exitPublished = true;
    const event: SessionExitEvent = {
      type: "exit",
      session: this.info(),
      ...(typeof this.details.exitCode === "number" ? { exitCode: this.details.exitCode } : {}),
    };
    for (const subscriber of this.subscribers) {
      if (subscriber.timer) clearTimeout(subscriber.timer);
      subscriber.timer = null;
      subscriber.latestFrame = null;
      try {
        subscriber.listener(event);
      } catch {
        // 退出通知是尽力而为；关闭流程不能被单个订阅器阻塞。
      }
    }
  }

  protocolResponse(data: string): void {
    if (this.closing || this.exited || this.fault) return;
    const rewritten = this.profile ? rewriteTerminalProfileReplies(data, this.profile) : data;
    if (!rewritten || !this.protocolGuard.shouldForward(rewritten)) return;
    try {
      this.pty.write(rewritten);
    } catch (error) {
      this.setFault(error);
    }
  }

  private setFault(error: unknown): void {
    this.fault ??= error instanceof Error ? error : new Error(String(error));
    this.recorder?.markTruncated();
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.then(
      () => {},
      () => {}
    );
    return result;
  }

  /** Operations already queued may still be committing after their caller was cancelled. */
  whenQueuedOperationsSettle(): Promise<void> {
    return this.tail;
  }

  private assertUsable(requireRunning = false): void {
    if (this.closing || this.details.status === "closed") {
      throw new TuiLensError("SESSION_CLOSED", "会话已关闭");
    }
    if (this.fault) throw new TuiLensError("ENGINE_FAILED", "终端引擎处理失败", { reason: this.fault.message });
    if (requireRunning && (this.exited || this.details.status !== "running")) {
      throw new TuiLensError("PROCESS_EXITED", "终端进程已经退出");
    }
  }

  private receive(data: string): void {
    if (this.closing || this.fault) return;
    this.protocolGuard.observeOutput(data);
    const bytes = Buffer.byteLength(data);
    this.counters.receivedBytes += bytes;
    // 暂停时仍可能有数据在途；硬上限防止失控进程耗尽守护进程内存。
    if (this.counters.pendingBytes + bytes > MAX_PENDING_BYTES) {
      this.setFault(new Error("终端待处理输出超过 16 MiB"));
      try {
        this.pty.kill();
      } catch (error) {
        this.setFault(error);
      }
      return;
    }
    this.counters.pendingBytes += bytes;
    this.counters.peakPendingBytes = Math.max(this.counters.peakPendingBytes, this.counters.pendingBytes);
    if (this.pausedAt === undefined && this.counters.pendingBytes > MAX_PENDING_BYTES / 2) {
      try {
        this.pty.pause();
        this.pausedAt = performance.now();
        this.counters.pauseCount += 1;
      } catch (error) {
        this.setFault(error);
      }
    }
    let start = 0;
    while (start < data.length) {
      let end = Math.min(data.length, start + MAX_BATCH_CHARS - this.batchChars);
      // 不在 UTF-16 代理对中间切断，避免浏览器两次 write 产生替换字符。
      const last = data.charCodeAt(end - 1);
      if (end < data.length && last >= 0xd800 && last <= 0xdbff) end -= 1;
      if (end <= start) {
        this.sealBatch();
        continue;
      }
      const part = data.slice(start, end);
      this.batch.push(part);
      this.batchChars += part.length;
      this.batchBytes += Buffer.byteLength(part);
      start = end;
      if (this.batchChars >= MAX_BATCH_CHARS - 1) this.sealBatch();
    }
    // 同一事件循环批次合并；显式操作会主动封口，保持其与之前数据的顺序。
    if (this.batch.length && this.batchTimer === undefined) {
      this.batchTimer = setImmediate(() => this.sealBatch());
    }
  }

  private sealBatch(): void {
    if (this.batchTimer !== undefined) clearImmediate(this.batchTimer);
    this.batchTimer = undefined;
    if (!this.batch.length) return;
    const data = this.batch.join("");
    const bytes = this.batchBytes;
    this.batch = [];
    this.batchChars = 0;
    this.batchBytes = 0;
    void this.enqueue(async () => {
      try {
        if (!this.closing && !this.fault) {
          await this.engine.write(data);
          await this.recorder?.append({ type: "output", data });
          this.counters.appliedBytes += bytes;
          this.counters.writeBatches += 1;
          this.frameId += 1;
          this.publishFrame();
        }
      } finally {
        this.counters.pendingBytes -= bytes;
        if (this.pausedAt !== undefined && this.counters.pendingBytes < MAX_PENDING_BYTES / 4) {
          this.counters.pauseDurationMs += performance.now() - this.pausedAt;
          this.pausedAt = undefined;
          if (!this.closing && !this.exited) this.pty.resume();
        }
      }
    }).catch((error: unknown) => this.setFault(error));
  }

  observe(
    options: ObserveOptions = {},
    control: OperationControl = {},
    frame: FrameAccessOptions = {}
  ): Promise<Observation> {
    this.assertUsable();
    return this.observeReady(options, control, frame);
  }

  /**
   * 服务端 watch：订阅会话变化并按 intervalMs 合并，主动推送 compact 画面。
   * timeoutMs 到期属于正常结束；客户端取消或会话关闭仍返回对应错误。
   */
  async watch(
    intervalMs: number,
    control: OperationControl,
    emit: (event: "frame" | "exit", data: unknown) => void,
    timeoutMs?: number
  ): Promise<WatchResult> {
    this.assertUsable();
    if (!Number.isInteger(intervalMs) || intervalMs < 50 || intervalMs > 60_000) {
      throw new TuiLensError("INVALID_ARGUMENT", "watch interval 必须是 50～60000 ms 的整数");
    }
    if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 86_400_000)) {
      throw new TuiLensError("INVALID_ARGUMENT", "watch timeout 必须是 0～86400000 ms 的整数");
    }

    const localStop = new AbortController();
    const signal = control.signal
      ? AbortSignal.any([control.signal, localStop.signal, this.closeController.signal])
      : AbortSignal.any([localStop.signal, this.closeController.signal]);
    let timedOut = false;
    let dirty = true;
    let exited = false;
    let frames = 0;
    let lastFrame = -1;
    let wake: (() => void) | undefined;
    const subscription = this.subscribe(
      (event) => {
        dirty = true;
        if (event.type === "exit") exited = true;
        const resolve = wake;
        wake = undefined;
        resolve?.();
      },
      { coalesceMs: intervalMs }
    );
    const timer =
      timeoutMs !== undefined && timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            localStop.abort();
            const resolve = wake;
            wake = undefined;
            resolve?.();
          }, timeoutMs)
        : undefined;
    const abort = (): void => {
      const resolve = wake;
      wake = undefined;
      resolve?.();
    };
    signal.addEventListener("abort", abort, { once: true });

    const waitForChange = (): Promise<void> =>
      new Promise<void>((resolve) => {
        if (dirty || exited || timedOut || signal.aborted) {
          resolve();
          return;
        }
        wake = resolve;
      });

    try {
      while (true) {
        if (timedOut) return { frames, timedOut: true };
        if (signal.aborted) {
          throw new TuiLensError(this.closing ? "SESSION_CLOSED" : "ABORTED", "watch 已取消");
        }
        if (dirty) {
          dirty = false;
          try {
            const observation = await this.observe({ view: "compact", screenshot: false }, { signal });
            if (observation.snapshot.frameId !== lastFrame) {
              lastFrame = observation.snapshot.frameId;
              frames += 1;
              emit("frame", observation);
            }
          } catch (error) {
            if (timedOut) return { frames, timedOut: true };
            if (signal.aborted) {
              throw new TuiLensError(this.closing ? "SESSION_CLOSED" : "ABORTED", "watch 已取消");
            }
            if (
              !(error instanceof TuiLensError) ||
              !["FRAME_PENDING", "PROCESS_EXITED", "SESSION_CLOSED"].includes(error.code)
            ) {
              throw error;
            }
            if (error.code === "FRAME_PENDING") {
              // The pending synchronized frame may end without another output batch.
              // Re-arm the dirty flag and retry instead of waiting for a publish.
              dirty = true;
              try {
                await sleep(8, undefined, { signal });
              } catch {
                if (timedOut) return { frames, timedOut: true };
                if (signal.aborted) {
                  throw new TuiLensError(this.closing ? "SESSION_CLOSED" : "ABORTED", "watch 已取消");
                }
              }
            }
          }
        }
        if (exited || this.details.status !== "running") {
          emit("exit", this.info());
          return { frames, timedOut: false };
        }
        await waitForChange();
      }
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      subscription.dispose();
    }
  }

  async hasText(text: string, control: OperationControl): Promise<boolean | undefined> {
    if (!this.engine.hasText) return undefined;
    this.assertUsable();
    this.sealBatch();
    const pending = this.enqueue(async () => {
      this.assertUsable();
      if (control.signal?.aborted) throw new TuiLensError("ABORTED", "等待已取消");
      return this.engine.hasText!(text);
    });
    return controlled(pending, control);
  }

  async probeText(
    text: string,
    region: Region | undefined,
    style: MatchStyle | undefined,
    control: OperationControl
  ): Promise<(TextProbe & { frameId: number }) | undefined> {
    if (!this.engine.probeText) return undefined;
    this.assertUsable();
    this.sealBatch();
    const pending = this.enqueue(async () => {
      this.assertUsable();
      if (control.signal?.aborted) throw new TuiLensError("ABORTED", "等待已取消");
      const result = await this.engine.probeText!(text, region, style);
      return { ...result, frameId: this.frameId };
    });
    return controlled(pending, control);
  }

  async paint(control: OperationControl = {}): Promise<{ paintMs: number } | undefined> {
    if (!this.engine.paint) return undefined;
    this.assertUsable();
    this.sealBatch();
    const pending = this.enqueue(async () => {
      this.assertUsable();
      return this.engine.paint!();
    });
    return controlled(pending, control);
  }

  private async observeReady(
    options: ObserveOptions,
    control: OperationControl,
    frame: FrameAccessOptions = {}
  ): Promise<Observation> {
    const view: ObserveView = options.view ?? "compact";
    if (!["compact", "diff", "full", "cells"].includes(view)) {
      throw new TuiLensError("INVALID_ARGUMENT", "observe.view 必须是 compact、diff、full 或 cells");
    }
    if (view === "diff" && options.fromFrameId === undefined) {
      throw new TuiLensError("INVALID_ARGUMENT", "observe view=diff 需要 fromFrameId");
    }
    if (options.fromFrameId !== undefined && (!Number.isInteger(options.fromFrameId) || options.fromFrameId < 0)) {
      throw new TuiLensError("INVALID_ARGUMENT", "observe.fromFrameId 必须是非负整数");
    }
    const deadline = performance.now() + (control.timeoutMs ?? 10_000);
    let lastError: unknown;
    const signal = control.signal
      ? AbortSignal.any([control.signal, this.closeController.signal])
      : this.closeController.signal;
    do {
      this.assertUsable();
      if (signal.aborted) throw new TuiLensError("ABORTED", "操作已取消");
      this.sealBatch();
      let cancelled = false;
      const pending = this.enqueue(async () => {
        this.assertUsable();
        if (cancelled || signal.aborted) throw new TuiLensError("ABORTED", "观察已取消");
        const lineCells = new Map<number, readonly string[]>();
        const frameOptions: FrameAccessOptions = {
          ...frame,
          cells: view === "cells",
          ...(options.scrollback === undefined ? {} : { scrollback: options.scrollback }),
        };
        snapshotLineCells.set(frameOptions, lineCells);
        let snapshot: TerminalSnapshot;
        try {
          snapshot = await this.engine.snapshot(this.frameId, frameOptions);
        } finally {
          snapshotLineCells.delete(frameOptions);
        }
        if (options.region) regionWithin(options.region, snapshot.cols, snapshot.rows);
        const base = view === "diff" ? this.frameHistory.get(options.fromFrameId!) : undefined;
        const target = this.rememberFrame(snapshot, lineCells);
        let visible = snapshot;
        let diff: SnapshotDiff | undefined;
        if (view === "compact") {
          visible = compactSnapshot(snapshot);
        } else if (view === "full") {
          visible = { ...snapshot, cells: [] };
        } else if (view === "diff") {
          if (base) {
            diff = {
              ...diffSnapshots(base, target),
              omittedSnapshotText: true,
            };
            visible = { ...snapshot, text: "", lines: [], cells: [] };
          } else {
            diff = {
              baseFrameId: options.fromFrameId!,
              targetFrameId: snapshot.frameId,
              unchanged: false,
              changedLines: [],
              fallbackFull: true,
            };
            visible = compactSnapshot(snapshot);
          }
        }
        const observation: Observation = {
          session: this.info(),
          snapshot: visible,
          screenshot: null,
          ...(diff ? { diff } : {}),
        };
        if (cancelled || signal.aborted) throw new TuiLensError("ABORTED", "观察已取消");
        if (options.screenshot === true) {
          const capture = await this.engine.screenshot(options.region, { cursor: options.cursor ?? "hide" });
          if (cancelled || signal.aborted) throw new TuiLensError("ABORTED", "观察已取消");
          const prefix = join(this.artifactDir, `${this.details.id}-${this.frameId}-${++this.observationId}`);
          await mkdir(this.artifactDir, { recursive: true, mode: 0o700 });
          const path = `${prefix}.png`;
          await writeFile(path, capture.png, { mode: 0o600 });
          observation.screenshot = {
            path,
            width: capture.width,
            height: capture.height,
            frameId: snapshot.frameId,
            ...(options.region ? { region: options.region } : {}),
            cursor: options.cursor === "show" ? "shown" : "hidden",
          };
          // 截图可能刚刚按需挂载可视化层；元数据必须反映挂载后的真实 renderer。
          observation.session = this.info();
          await writeFile(`${prefix}.json`, JSON.stringify(observation, null, 2), { mode: 0o600 });
        }
        return observation;
      });
      try {
        return await controlled(pending, {
          signal,
          timeoutMs: Math.max(1, deadline - performance.now()),
        });
      } catch (error) {
        cancelled = true;
        if (this.closing) throw new TuiLensError("SESSION_CLOSED", "会话已关闭");
        if (!(error instanceof TuiLensError) || error.code !== "FRAME_PENDING") throw error;
        if (frame.allowPendingFrame !== true) lastError = error;
        // 同步输出的结束序列仍需消费；必须释放队列后再等待，不能持锁等下一帧。
        await controlled(sleep(8), {
          signal,
          timeoutMs: Math.max(1, deadline - performance.now()),
        }).catch((timeoutError: unknown) => {
          if (
            lastError instanceof TuiLensError &&
            timeoutError instanceof TuiLensError &&
            timeoutError.code === "OPERATION_TIMEOUT"
          )
            throw lastError;
          throw timeoutError;
        });
      }
    } while (performance.now() < deadline);
    throw new TuiLensError("FRAME_PENDING", "应用的同步输出帧未在期限内结束");
  }

  input(action: InputAction, guard?: InputGuard, control: OperationControl = {}): Promise<SessionInfo> {
    return this.inputWithFrame(action, guard, control).then((result) => result.session);
  }

  inputWithFrame(
    action: InputAction,
    guard?: InputGuard,
    control: OperationControl = {}
  ): Promise<{
    session: SessionInfo;
    frameId: number;
    cursor: CursorState;
  }> {
    return this.inputWithFrameOptions(action, guard, control);
  }

  inputWithFrameOptions(
    action: InputAction,
    guard: InputGuard | undefined,
    control: OperationControl = {},
    frame: FrameAccessOptions = {}
  ): Promise<{
    session: SessionInfo;
    frameId: number;
    cursor: CursorState;
  }> {
    this.assertUsable(true);
    this.sealBatch();
    let cancelled = false;
    const check = () => {
      if (cancelled || control.signal?.aborted) throw new TuiLensError("ABORTED", "输入已取消");
    };
    const pending = this.enqueue(async () => {
      this.assertUsable(true);
      check();
      inputGuard(guard, this.details.cols, this.details.rows);
      if (guard?.frameId !== undefined && guard.frameId !== this.frameId) {
        throw new TuiLensError("STALE_FRAME", "操作引用的画面已过期，请重新观察");
      }
      if (guard?.region) {
        const snapshot = await this.engine.snapshot(this.frameId, frame);
        if (regionFingerprint(snapshot, guard.region.bounds) !== guard.region.fingerprint) {
          throw new TuiLensError("STALE_REGION", "操作目标区域已变化，请重新定位");
        }
      }
      // 输入只需模式和尺寸，不读整屏字符格，也不等待绘制。
      const state = await this.engine.state();
      check();
      const inputFrameId = this.frameId;
      // 到达首/尾的滚动分批发往 PTY：单次写入 2000 个事件会形成突发输入，
      // 且无法在中间取消。普通输入仍是一次写入。
      const batches = encodeScrollBatches(action, state);
      if (batches) {
        for (const batch of batches) {
          check();
          if (this.closing || this.exited) throw new TuiLensError("PROCESS_EXITED", "终端进程已经退出");
          this.pty.write(batch);
          // 让出事件循环，使取消、背压与退出事件能在这批之间生效。
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
      } else {
        this.pty.write(encodeInput(action, state));
      }
      await this.recorder?.append({ type: "input", action });
      return { session: this.info(), frameId: inputFrameId, cursor: state.cursor };
    });
    return controlled(pending, { timeoutMs: 10000, ...control }).catch((error) => {
      cancelled = true;
      throw error;
    });
  }

  resize(cols: number, rows: number, control: OperationControl = {}): Promise<SessionInfo> {
    dimensions(cols, rows);
    this.assertUsable(true);
    this.sealBatch();
    let cancelled = false;
    const pending = this.enqueue(async () => {
      this.assertUsable(true);
      if (cancelled || control.signal?.aborted) throw new TuiLensError("ABORTED", "尺寸变更已取消");
      // 一旦开始变更引擎尺寸，必须同步更新 PTY，不能在中间取消形成两套尺寸。
      await this.engine.resize(cols, rows);
      this.pty.resize(cols, rows);
      this.details.cols = cols;
      this.details.rows = rows;
      await this.recorder?.append({ type: "resize", cols, rows });
      this.frameId += 1;
      this.publishFrame();
      return this.info();
    });
    return controlled(pending, { timeoutMs: 10000, ...control }).catch((error) => {
      cancelled = true;
      throw error;
    });
  }

  async waitForExit(control: OperationControl): Promise<void> {
    this.assertUsable();
    if (this.details.status === "exited") return;
    const signal = control.signal
      ? AbortSignal.any([control.signal, this.closeController.signal])
      : this.closeController.signal;
    // 不向一个永久 Promise 持续追加 then；超时/取消后移除订阅，长期运行不会积累等待者。
    await new Promise<void>((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      const cleanup = () => {
        clearTimeout(timer);
        this.exitWaiters.delete(done);
        signal.removeEventListener("abort", abort);
      };
      const done = () => {
        cleanup();
        resolve();
      };
      const abort = () => {
        cleanup();
        reject(new TuiLensError(this.closing ? "SESSION_CLOSED" : "ABORTED", "等待已取消"));
      };
      if (signal.aborted) {
        abort();
        return;
      }
      this.exitWaiters.add(done);
      signal.addEventListener("abort", abort, { once: true });
      timer = setTimeout(() => {
        cleanup();
        reject(new TuiLensError("WAIT_TIMEOUT", "进程未在期限内退出"));
      }, control.timeoutMs ?? 10_000);
    });
    this.assertUsable();
  }

  close(): Promise<void> {
    this.closePromise ??= this.closeResources();
    return this.closePromise;
  }

  private async closeResources(): Promise<void> {
    // 显式关闭会丢弃仍在排队的数据，不能把这份录制标记为完整。
    if (this.counters.receivedBytes !== this.counters.appliedBytes || this.fault) this.recorder?.markTruncated();
    this.closing = true;
    this.closeController.abort();
    this.sealBatch();
    let closeError: unknown;
    try {
      if (!this.exited) {
        this.pty.kill();
        try {
          await controlled(this.exitPromise, { timeoutMs: 1500 }, "PROCESS_STOP_TIMEOUT");
        } catch {
          if (process.platform === "win32") this.pty.kill();
          else this.pty.kill("SIGKILL");
          await controlled(this.exitPromise, { timeoutMs: 1500 }, "PROCESS_STOP_TIMEOUT");
        }
      } else if (process.platform === "win32") {
        // node-pty 的自然退出仅关闭输出管道；显式 kill 还会释放 ConPTY worker 与输入句柄。
        this.pty.kill();
      }
    } catch (error) {
      closeError = error;
    }
    this.pty.dispose?.();
    for (const disposable of this.disposables.splice(0)) disposable.dispose();
    // 先关闭浏览器可打断卡住的 evaluate；再等待队列收敛，不能让 close 无限悬挂。
    try {
      await this.engine.close();
    } catch (error) {
      closeError ??= error;
    }
    try {
      await controlled(this.tail, { timeoutMs: 2000 });
    } catch (error) {
      closeError ??= error;
    }
    try {
      await this.recorder?.close();
    } catch (error) {
      closeError ??= error;
    }
    this.details.status = "closed";
    this.publishExit();
    this.frameHistory.clear();
    for (const subscriber of this.subscribers) {
      if (subscriber.timer) clearTimeout(subscriber.timer);
    }
    this.subscribers.clear();
    if (closeError) throw closeError;
  }
}
