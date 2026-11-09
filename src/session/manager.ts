import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import * as nodePty from "node-pty";
import { TuiLensError } from "../core/errors.js";
import { findText, regionFingerprint } from "../core/locator.js";
import type {
  InputAction, LaunchOptions, ManagerOptions, Observation, ObserveOptions,
  Region, SessionInfo, TextMatch, WaitOptions, WaitResult,
} from "../core/types.js";
import { launchOptions, waitOptions } from "../core/validation.js";
import { createBrowserEngine } from "../engine/browser-engine.js";
import { ManagedSession, type OperationControl, type SessionMetrics } from "./session.js";

/** 应用服务同时供 CLI 与 MCP 使用，不依赖具体传输协议。 */
export class SessionManager {
  private readonly sessions = new Map<string, ManagedSession>();
  private readonly pendingLaunches = new Set<Promise<SessionInfo>>();
  private readonly closedIds = new Set<string>();
  private readonly launchCleanupErrors: unknown[] = [];
  private disposed = false;
  private closing: Promise<void> | undefined;

  constructor(private readonly options: ManagerOptions) {}

  async launch(options: LaunchOptions): Promise<SessionInfo> {
    launchOptions(options);
    if (this.disposed) throw new TuiLensError("MANAGER_CLOSED", "会话管理器已关闭");
    if (this.sessions.size + this.pendingLaunches.size >= 8) {
      throw new TuiLensError("SESSION_LIMIT", "最多同时保留 8 个会话，请先关闭不再使用的会话");
    }
    const pending = this.launchProcess(options);
    this.pendingLaunches.add(pending);
    try {
      return await pending;
    } finally {
      this.pendingLaunches.delete(pending);
    }
  }

  private async launchProcess(options: LaunchOptions): Promise<SessionInfo> {
    const cwd = resolve(options.cwd ?? process.cwd());
    try {
      if (!(await stat(cwd)).isDirectory()) throw new Error("不是目录");
    } catch {
      throw new TuiLensError("INVALID_CWD", "cwd 不存在或不是可读取目录");
    }
    const cols = options.cols ?? 160;
    const rows = options.rows ?? 50;
    let pty: nodePty.IPty | undefined;
    let session: ManagedSession | undefined;
    const engine = await (this.options.engineFactory ?? createBrowserEngine)({
      cols, rows,
      onData: (data) => { session?.protocolResponse(data); },
      ...(this.options.executablePath ? { executablePath: this.options.executablePath } : {}),
      ...(this.options.fontFamily ? { fontFamily: this.options.fontFamily } : {}),
    });
    try {
      if (this.disposed) throw new TuiLensError("MANAGER_CLOSED", "管理器在启动期间已关闭");
      const env = Object.fromEntries(Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ));
      // 环境声明与实际颜色能力保持一致；不继承宿主误报的图片协议。
      delete env.COLORTERM;
      delete env.FORCE_COLOR;
      delete env.NO_COLOR;
      delete env.TERM_PROGRAM;
      delete env.KITTY_WINDOW_ID;
      delete env.WEZTERM_PANE;
      Object.assign(env, {
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
        ...options.env,
      });
      if (options.colorMode === "ansi256") {
        delete env.COLORTERM;
        delete env.NO_COLOR;
        env.FORCE_COLOR = "2";
      } else if (options.colorMode === "none") {
        delete env.COLORTERM;
        env.NO_COLOR = "1";
        env.FORCE_COLOR = "0";
      } else if (options.colorMode === "truecolor") {
        delete env.NO_COLOR;
        env.COLORTERM = "truecolor";
        env.FORCE_COLOR = "3";
      }
      pty = nodePty.spawn(options.command, options.args ?? [], { name: "xterm-256color", cols, rows, cwd, env });
      const info: SessionInfo = {
        id: randomUUID(), pid: pty.pid, cols, rows, status: "running",
        exitCode: null, createdAt: new Date().toISOString(),
      };
      session = new ManagedSession(info, engine, pty, resolve(this.options.artifactDir));
      this.sessions.set(info.id, session);
      return session.info();
    } catch (error) {
      const cleanupErrors: unknown[] = [];
      try { pty?.kill(); } catch (cleanupError) { cleanupErrors.push(cleanupError); }
      try { await engine.close(); } catch (cleanupError) { cleanupErrors.push(cleanupError); }
      if (cleanupErrors.length) {
        this.launchCleanupErrors.push(...cleanupErrors);
        throw new AggregateError([error, ...cleanupErrors], "启动失败且部分资源清理失败");
      }
      if (error instanceof TuiLensError) throw error;
      throw new TuiLensError("PROCESS_START_FAILED", "无法启动终端进程", {
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private session(id: string): ManagedSession {
    const session = this.sessions.get(id);
    if (!session) throw new TuiLensError("SESSION_NOT_FOUND", "未找到指定会话", { id });
    return session;
  }

  list(): SessionInfo[] {
    return [...this.sessions.values()].map((session) => session.info());
  }

  /** 无浏览器调用的计数快照，性能采样不能复用完整 observe。 */
  metrics(id: string): SessionMetrics {
    return this.session(id).metrics();
  }

  observe(id: string, options?: ObserveOptions, control?: OperationControl): Promise<Observation> {
    return this.session(id).observe(options, control);
  }

  input(id: string, action: InputAction): Promise<SessionInfo> {
    return this.session(id).input(action);
  }

  resize(id: string, cols: number, rows: number): Promise<SessionInfo> {
    return this.session(id).resize(cols, rows);
  }

  async find(id: string, text: string, region?: Region, control?: OperationControl): Promise<TextMatch[]> {
    const observation = await this.observe(id, { screenshot: false }, control);
    return findText(observation.snapshot, text, region);
  }

  async wait(id: string, options: WaitOptions): Promise<WaitResult> {
    waitOptions(options);
    const session = this.session(id);
    const started = performance.now();
    const timeout = options.timeoutMs ?? 10_000;
    const stable = new Map<number, { fingerprint: string; since: number }>();
    const remainingControl = () => ({
      timeoutMs: Math.max(1, timeout - (performance.now() - started)),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    // 生命周期等待不应轮询字符格；退出事件排在最后一批输出之后。
    if (options.conditions.every((condition) => condition.kind === "exited")) {
      try {
        await session.waitForExit(remainingControl());
        const observation = await session.observe({ screenshot: false }, remainingControl());
        return { observation, elapsedMs: performance.now() - started };
      } catch (error) {
        if (!(error instanceof TuiLensError) || !["WAIT_TIMEOUT", "OPERATION_TIMEOUT", "FRAME_PENDING"].includes(error.code)) throw error;
        return this.timeoutEvidence(session, timeout, options.signal);
      }
    }
    while (performance.now() - started < timeout) {
      if (options.signal?.aborted) throw new TuiLensError("ABORTED", "等待已取消");
      let observation: Observation;
      try {
        observation = await session.observe({ screenshot: false }, remainingControl());
      } catch (error) {
        if (error instanceof TuiLensError && ["OPERATION_TIMEOUT", "FRAME_PENDING"].includes(error.code)) break;
        throw error;
      }
      const now = performance.now();
      const matches = options.conditions.map((condition, index) => {
        switch (condition.kind) {
          case "text": {
            const found = findText(observation.snapshot, condition.text, condition.region).length > 0;
            return condition.absent ? !found : found;
          }
          case "size":
            return observation.snapshot.cols === condition.cols && observation.snapshot.rows === condition.rows;
          case "exited":
            return observation.session.status === "exited";
          case "stable": {
            const fingerprint = regionFingerprint(observation.snapshot, condition.region);
            const previous = stable.get(index);
            if (!previous || previous.fingerprint !== fingerprint) {
              stable.set(index, { fingerprint, since: now });
              return false;
            }
            return now - previous.since >= (condition.durationMs ?? 250);
          }
        }
      });
      if (matches.every(Boolean)) return { observation, elapsedMs: now - started };
      try {
        await sleep(Math.min(50, Math.max(1, timeout - (performance.now() - started))), undefined,
          options.signal ? { signal: options.signal } : {});
      } catch {
        throw new TuiLensError("ABORTED", "等待已取消");
      }
    }
    return this.timeoutEvidence(session, timeout, options.signal);
  }

  private async timeoutEvidence(session: ManagedSession, timeout: number, signal?: AbortSignal): Promise<never> {
    if (signal?.aborted) throw new TuiLensError("ABORTED", "等待已取消");
    // 超时证据也是有界操作；截图失败原因单列，不能把失败冒充为成功图片。
    let artifact: string | undefined;
    let artifactError: string | undefined;
    try {
      artifact = (await session.observe({}, {
        timeoutMs: 1000, ...(signal ? { signal } : {}),
      })).screenshot?.path;
    } catch (error) {
      if (signal?.aborted) throw new TuiLensError("ABORTED", "等待已取消");
      artifactError = error instanceof Error ? error.message : String(error);
    }
    throw new TuiLensError("WAIT_TIMEOUT", "等待条件未在期限内满足", {
      timeoutMs: timeout, ...(artifact ? { artifact } : {}),
      ...(artifactError ? { artifactError } : {}),
    });
  }

  async close(id: string): Promise<void> {
    if (this.closedIds.has(id)) return;
    const session = this.session(id);
    await session.close();
    this.sessions.delete(id);
    this.closedIds.add(id);
    // 幂等窗口有界，避免长驻服务持续关闭会话时积累无限标识。
    if (this.closedIds.size > 64) this.closedIds.delete(this.closedIds.values().next().value!);
  }

  closeAll(): Promise<void> {
    this.disposed = true;
    this.closing ??= this.closeResources();
    return this.closing;
  }

  private async closeResources(): Promise<void> {
    // 启动中的引擎也属于本管理器；closeAll 不能在它们完成清理前返回。
    await Promise.allSettled([...this.pendingLaunches]);
    const entries = [...this.sessions.entries()];
    const results = await Promise.allSettled(entries.map(async ([id, session]) => {
      await session.close();
      this.sessions.delete(id);
    }));
    const failed = results.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
    if (this.launchCleanupErrors.length) {
      throw new AggregateError(this.launchCleanupErrors, "启动中的资源未能全部释放");
    }
  }
}
