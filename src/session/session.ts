import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { IDisposable, IPty } from "node-pty";
import { TuiLensError } from "../core/errors.js";
import { encodeInput } from "../core/input.js";
import type {
  InputAction, Observation, ObserveOptions, SessionInfo, TerminalEngine,
} from "../core/types.js";
import { dimensions } from "../core/validation.js";

const MAX_PENDING_BYTES = 16 * 1024 * 1024;
const MAX_BATCH_CHARS = 32 * 1024;

export interface SessionMetrics {
  receivedBytes: number;
  appliedBytes: number;
  pendingBytes: number;
  peakPendingBytes: number;
  pauseCount: number;
  pauseDurationMs: number;
  writeBatches: number;
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
    promise.then(
      (value) => {
        if (finished) return;
        finished = true;
        cleanup();
        resolve(value);
      },
      fail,
    );
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
  private readonly closeController = new AbortController();
  private exited = false;
  private readonly counters: SessionMetrics = {
    receivedBytes: 0, appliedBytes: 0, pendingBytes: 0,
    peakPendingBytes: 0, pauseCount: 0, pauseDurationMs: 0, writeBatches: 0,
  };

  constructor(
    private readonly details: SessionInfo,
    private readonly engine: TerminalEngine,
    private readonly pty: IPty,
    private readonly artifactDir: string,
  ) {
    this.exitPromise = new Promise((resolve) => { this.resolveExit = resolve; });
    this.disposables.push(pty.onData((data) => this.receive(data)));
    this.disposables.push(pty.onExit(({ exitCode }) => {
      this.exited = true;
      this.resolveExit();
      // 最后一批输出先入队；已退出状态只能在它完成后对外可见。
      this.sealBatch();
      void this.enqueue(async () => {
        this.details.status = "exited";
        this.details.exitCode = exitCode;
        for (const wake of [...this.exitWaiters]) wake();
      }).catch((error: unknown) => this.setFault(error));
    }));
  }

  info(): SessionInfo { return { ...this.details }; }

  metrics(): SessionMetrics {
    return {
      ...this.counters,
      pauseDurationMs: this.counters.pauseDurationMs
        + (this.pausedAt === undefined ? 0 : performance.now() - this.pausedAt),
    };
  }

  protocolResponse(data: string): void {
    if (this.closing || this.exited || this.fault) return;
    try { this.pty.write(data); } catch (error) { this.setFault(error); }
  }

  private setFault(error: unknown): void {
    this.fault ??= error instanceof Error ? error : new Error(String(error));
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.then(() => {}, () => {});
    return result;
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
    const bytes = Buffer.byteLength(data);
    this.counters.receivedBytes += bytes;
    // 暂停时仍可能有数据在途；硬上限防止失控进程耗尽守护进程内存。
    if (this.counters.pendingBytes + bytes > MAX_PENDING_BYTES) {
      this.setFault(new Error("终端待处理输出超过 16 MiB"));
      try { this.pty.kill(); } catch (error) { this.setFault(error); }
      return;
    }
    this.counters.pendingBytes += bytes;
    this.counters.peakPendingBytes = Math.max(this.counters.peakPendingBytes, this.counters.pendingBytes);
    if (this.pausedAt === undefined && this.counters.pendingBytes > MAX_PENDING_BYTES / 2) {
      try {
        this.pty.pause();
        this.pausedAt = performance.now();
        this.counters.pauseCount += 1;
      } catch (error) { this.setFault(error); }
    }
    let start = 0;
    while (start < data.length) {
      let end = Math.min(data.length, start + MAX_BATCH_CHARS - this.batchChars);
      // 不在 UTF-16 代理对中间切断，避免浏览器两次 write 产生替换字符。
      const last = data.charCodeAt(end - 1);
      if (end < data.length && last >= 0xd800 && last <= 0xdbff) end -= 1;
      if (end <= start) { this.sealBatch(); continue; }
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
          this.counters.appliedBytes += bytes;
          this.counters.writeBatches += 1;
          this.frameId += 1;
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

  observe(options: ObserveOptions = {}, control: OperationControl = {}): Promise<Observation> {
    this.assertUsable();
    return this.observeReady(options, control);
  }

  private async observeReady(options: ObserveOptions, control: OperationControl): Promise<Observation> {
    const deadline = performance.now() + (control.timeoutMs ?? 10_000);
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
        const snapshot = await this.engine.snapshot(this.frameId);
        const observation: Observation = { session: this.info(), snapshot, screenshot: null };
        if (cancelled || signal.aborted) throw new TuiLensError("ABORTED", "观察已取消");
        if (options.screenshot !== false) {
          const capture = await this.engine.screenshot();
          if (cancelled || signal.aborted) throw new TuiLensError("ABORTED", "观察已取消");
          const prefix = join(this.artifactDir, `${this.details.id}-${this.frameId}-${++this.observationId}`);
          await mkdir(this.artifactDir, { recursive: true, mode: 0o700 });
          const path = `${prefix}.png`;
          await writeFile(path, capture.png, { mode: 0o600 });
          observation.screenshot = {
            path, width: capture.width, height: capture.height, frameId: snapshot.frameId,
          };
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
        // 同步输出的结束序列仍需消费；必须释放队列后再等待，不能持锁等下一帧。
        await controlled(sleep(8), {
          signal,
          timeoutMs: Math.max(1, deadline - performance.now()),
        });
      }
    } while (performance.now() < deadline);
    throw new TuiLensError("FRAME_PENDING", "应用的同步输出帧未在期限内结束");
  }

  input(action: InputAction): Promise<SessionInfo> {
    this.assertUsable(true);
    this.sealBatch();
    return this.enqueue(async () => {
      this.assertUsable(true);
      // 输入只需模式和尺寸，不读整屏字符格，也不等待绘制。
      const state = await this.engine.state();
      this.pty.write(encodeInput(action, state));
      return this.info();
    });
  }

  resize(cols: number, rows: number): Promise<SessionInfo> {
    dimensions(cols, rows);
    this.assertUsable(true);
    this.sealBatch();
    return this.enqueue(async () => {
      this.assertUsable(true);
      await this.engine.resize(cols, rows);
      this.pty.resize(cols, rows);
      this.details.cols = cols;
      this.details.rows = rows;
      this.frameId += 1;
      return this.info();
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
      const done = () => { cleanup(); resolve(); };
      const abort = () => {
        cleanup();
        reject(new TuiLensError(this.closing ? "SESSION_CLOSED" : "ABORTED", "等待已取消"));
      };
      if (signal.aborted) { abort(); return; }
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
    } catch (error) { closeError = error; }
    for (const disposable of this.disposables.splice(0)) disposable.dispose();
    // 先关闭浏览器可打断卡住的 evaluate；再等待队列收敛，不能让 close 无限悬挂。
    try { await this.engine.close(); } catch (error) { closeError ??= error; }
    try { await controlled(this.tail, { timeoutMs: 2000 }); } catch (error) { closeError ??= error; }
    this.details.status = "closed";
    if (closeError) throw closeError;
  }
}
