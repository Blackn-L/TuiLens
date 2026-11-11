import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import * as nodePty from "node-pty";
import { TuiLensError } from "../core/errors.js";
import { findText, regionFingerprint } from "../core/locator.js";
import { clickTarget } from "../core/click-target.js";
import { resolveExecutable } from "../core/executable.js";
import type {
  ClickTextOptions, InputAction, InputAndWaitResult, InputGuard, InputWaitOptions, LaunchOptions, ManagerOptions,
  MatchOptions, Observation, ObserveOptions, Region, SessionInfo, TextMatch, WaitOptions, WaitResult,
} from "../core/types.js";
import { clickTextOptions, integer, launchOptions, waitOptions } from "../core/validation.js";
import { createBrowserEngine } from "../engine/browser-engine.js";
import { ManagedSession, type OperationControl, type SessionMetrics } from "./session.js";
import { RecordingWriter } from "../recording/writer.js";
import { replayRecording, type ReplayOptions } from "../recording/replay.js";
import { compareArtifact, type VisualOptions } from "../visual/artifacts.js";
import { runScenario } from "../scenario/runner.js";

const MIN_SCREENSHOT_TIMEOUT_MS = 5_000;

/** 应用服务同时供 CLI 与 MCP 使用，不依赖具体传输协议。 */
export class SessionManager {
  private readonly sessions = new Map<string, ManagedSession>();
  private readonly pendingLaunches = new Set<Promise<SessionInfo>>();
  private readonly closedIds = new Set<string>();
  private readonly launchCleanupErrors: unknown[] = [];
  private readonly offline = new Map<Promise<unknown>, AbortController>();
  private disposed = false;
  private closing: Promise<void> | undefined;

  constructor(private readonly options: ManagerOptions) {}

  async launch(options: LaunchOptions): Promise<SessionInfo> {
    launchOptions(options);
    if (this.disposed) throw new TuiLensError("MANAGER_CLOSED", "会话管理器已关闭");
    if (this.sessions.size + this.pendingLaunches.size + this.offline.size >= 8) {
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
    let recorder: RecordingWriter | undefined;
    const engine = await (this.options.engineFactory ?? createBrowserEngine)({
      cols, rows,
      images: options.images ?? "off",
      onData: (data) => { session?.protocolResponse(data); },
      ...(this.options.executablePath ? { executablePath: this.options.executablePath } : {}),
      ...(this.options.fontFamily ? { fontFamily: this.options.fontFamily } : {}),
    });
    try {
      if (this.disposed) throw new TuiLensError("MANAGER_CLOSED", "管理器在启动期间已关闭");
      const sessionId = randomUUID();
      if (options.recording) recorder = await RecordingWriter.create(resolve(this.options.artifactDir), sessionId,
        { type: "header", version: 1, cols, rows, images: options.images ?? "off" }, options.recording.maxBytes);
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
      const pathOverride = Object.keys(options.env ?? {}).find((key) => key.toLowerCase() === "path");
      if (pathOverride) {
        for (const key of Object.keys(env)) {
          if (key.toLowerCase() === "path") delete env[key];
        }
        env[pathOverride] = options.env![pathOverride]!;
      }
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
      const requested = process.platform === "win32" && ["node", "nodejs", "node.exe"].includes(options.command.toLowerCase())
        ? process.execPath : options.command;
      const resolved = await resolveExecutable(requested, { cwd, env });
      pty = nodePty.spawn(resolved.file, options.args ?? [], { name: "xterm-256color", cols, rows, cwd, env });
      const info: SessionInfo = {
        id: sessionId, pid: pty.pid, cols, rows, status: "running",
        exitCode: null, createdAt: new Date().toISOString(),
        ...(recorder ? { recordingPath: recorder.path } : {}),
        ...(resolved.resolved ? { resolvedCommand: resolved.resolved } : {}),
      };
      session = new ManagedSession(info, engine, pty, resolve(this.options.artifactDir), recorder, options.protocolReplies);
      this.sessions.set(info.id, session);
      return session.info();
    } catch (error) {
      const cleanupErrors: unknown[] = [];
      try { pty?.kill(); } catch (cleanupError) { cleanupErrors.push(cleanupError); }
      try { await engine.close(); } catch (cleanupError) { cleanupErrors.push(cleanupError); }
      try { await recorder?.close(); } catch (cleanupError) { cleanupErrors.push(cleanupError); }
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

  async replay(path: string, options: ReplayOptions = {}) {
    if (this.disposed) throw new TuiLensError("MANAGER_CLOSED", "会话管理器已关闭");
    if (this.sessions.size + this.pendingLaunches.size + this.offline.size >= 8) {
      throw new TuiLensError("SESSION_LIMIT", "会话和回放任务总数不能超过 8");
    }
    const controller = new AbortController();
    const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
    const task = replayRecording(path, this.options, { ...options, signal });
    this.offline.set(task, controller);
    try { return await task; } finally { this.offline.delete(task); }
  }
  scenario(specification: unknown, signal?: AbortSignal) { return runScenario(this, specification, this.options.artifactDir, signal); }
  async compare(id: string, options: VisualOptions, control?: OperationControl) {
    const observation = await this.observe(id, {
      ...(options.region ? { region: options.region } : {}),
      ...(options.cursor ? { cursor: options.cursor } : {}),
    }, control);
    return compareArtifact(observation.screenshot!.path, options, this.options.artifactDir);
  }

  observe(id: string, options?: ObserveOptions, control?: OperationControl): Promise<Observation> {
    return this.session(id).observe(options, control);
  }

  input(id: string, action: InputAction, guard?: InputGuard, control?: OperationControl): Promise<SessionInfo> {
    return this.session(id).input(action, guard, control);
  }

  async inputAndWait(
    id: string,
    action: InputAction,
    guard?: InputGuard,
    options: InputWaitOptions = {},
    control?: OperationControl,
    screenshot = false,
  ): Promise<InputAndWaitResult> {
    const session = this.session(id);
    if (options.timeoutMs !== undefined) integer(options.timeoutMs, "wait.timeoutMs", 1, 300_000);
    if (options.conditions?.length) {
      waitOptions({
        conditions: options.conditions,
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      });
    }
    const started = performance.now();
    const accepted = await session.inputWithFrame(action, guard, control);
    const timeout = options.timeoutMs ?? 10_000;
    const remaining = () => Math.max(1, timeout - (performance.now() - started));
    try {
      const waited = await this.wait(id, {
        conditions: options.conditions ?? [],
        timeoutMs: remaining(),
        afterFrameId: accepted.frameId,
        ...(control?.signal ? { signal: control.signal } : {}),
      }, true);
      const observation = screenshot
        ? await session.observe({ screenshot: true }, {
          timeoutMs: Math.max(MIN_SCREENSHOT_TIMEOUT_MS, remaining()),
          ...(control?.signal ? { signal: control.signal } : {}),
        })
        : waited.observation;
      return {
        session: observation.session,
        inputFrameId: accepted.frameId,
        cursorBefore: accepted.cursor,
        observation,
        elapsedMs: performance.now() - started,
      };
    } catch (error) {
      if (error instanceof TuiLensError) {
        const details = error.details && typeof error.details === "object" && !Array.isArray(error.details)
          ? error.details as Record<string, unknown> : {};
        throw new TuiLensError(error.code, error.message, {
          ...details, accepted: true, inputFrameId: accepted.frameId,
        });
      }
      throw error;
    }
  }

  resize(id: string, cols: number, rows: number, control?: OperationControl): Promise<SessionInfo> {
    return this.session(id).resize(cols, rows, control);
  }

  async find(id: string, text: string, region?: Region, control?: OperationControl, options?: MatchOptions): Promise<TextMatch[]> {
    const observation = await this.observe(id, { screenshot: false }, control);
    return findText(observation.snapshot, text, region, options).map((match) => ({
      ...match, frameId: observation.snapshot.frameId,
      fingerprint: regionFingerprint(observation.snapshot, match.region),
    }));
  }

  /** 原子点击使用已观察目标区域的指纹，动画改变其他区域不使它失效。 */
  async clickText(id: string, text: string, region?: Region, options: ClickTextOptions = {}, control?: OperationControl): Promise<SessionInfo> {
    clickTextOptions(options);
    const observation = await this.session(id).observe({ screenshot: false }, control,
      { allowPendingFrame: options.allowPendingFrame ?? false });
    const { allowPendingFrame, hitbox: _hitbox, point: _point, offset: _offset, button, modifiers, ...matching } = options;
    const matches = findText(observation.snapshot, text, region,
      matching.nth === undefined ? { selection: "unique", ...matching } : matching);
    if (matches.length !== 1) throw new TuiLensError("AMBIGUOUS_MATCH", "点击需要唯一匹配，或显式指定 nth");
    const match = matches[0]!;
    const target = clickTarget(match.region, observation.snapshot.cols, observation.snapshot.rows, options);
    return this.session(id).inputWithFrameOptions({
      type: "click", x: target.point.x, y: target.point.y,
      ...(button === undefined ? {} : { button }),
      ...(modifiers === undefined ? {} : { modifiers }),
    }, { region: { bounds: target.hitbox, fingerprint: regionFingerprint(observation.snapshot, target.hitbox) } }, control,
    { allowPendingFrame: allowPendingFrame ?? false }).then((result) => result.session);
  }

  async wait(id: string, options: WaitOptions, internal = false): Promise<WaitResult> {
    if (!internal) waitOptions(options);
    const session = this.session(id);
    const started = performance.now();
    const timeout = options.timeoutMs ?? 10_000;
    const stable = new Map<number, { fingerprint: string; since: number }>();
    const remainingControl = () => ({
      timeoutMs: Math.max(1, timeout - (performance.now() - started)),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    // 生命周期等待不应轮询字符格；退出事件排在最后一批输出之后。
    if (options.conditions.length > 0 && options.conditions.every((condition) => condition.kind === "exited")) {
      try {
        await session.waitForExit(remainingControl());
        const observation = await session.observe({ screenshot: false }, remainingControl());
        if (options.afterFrameId !== undefined && observation.snapshot.frameId <= options.afterFrameId) {
          return this.timeoutEvidence(session, timeout, options.signal);
        }
        return { observation, elapsedMs: performance.now() - started };
      } catch (error) {
        if (!(error instanceof TuiLensError) || !["WAIT_TIMEOUT", "OPERATION_TIMEOUT", "FRAME_PENDING"].includes(error.code)) throw error;
        return this.timeoutEvidence(session, timeout, options.signal);
      }
    }
    while (performance.now() - started < timeout) {
      if (options.signal?.aborted) throw new TuiLensError("ABORTED", "等待已取消");
      const only = options.conditions.length === 1 ? options.conditions[0] : undefined;
      if (only?.kind === "text" && !only.region && !only.style && only.count === undefined) {
        try {
          const found = await session.hasText(only.text, remainingControl());
          if (found !== undefined && (only.absent ? found : !found)) {
            await sleep(25, undefined, options.signal ? { signal: options.signal } : {});
            continue;
          }
        } catch (error) {
          if (options.signal?.aborted) throw new TuiLensError("ABORTED", "等待已取消");
          if (error instanceof TuiLensError && error.code === "FRAME_PENDING") {
            await sleep(8);
            continue;
          }
          if (error instanceof TuiLensError && error.code === "OPERATION_TIMEOUT") break;
          throw error;
        }
      }
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
            const count = findText(observation.snapshot, condition.text, condition.region,
              condition.style ? { style: condition.style } : undefined).length;
            if (condition.count !== undefined) return count === condition.count;
            return condition.absent ? count === 0 : count > 0;
          }
          case "size":
            return observation.snapshot.cols === condition.cols && observation.snapshot.rows === condition.rows;
          case "cursor": {
            const cursor = observation.snapshot.cursor;
            return (condition.x === undefined || cursor.x === condition.x)
              && (condition.y === undefined || cursor.y === condition.y)
              && (condition.visible === undefined || cursor.visible === condition.visible)
              && (condition.style === undefined || cursor.style === condition.style)
              && (condition.blink === undefined || cursor.blink === condition.blink);
          }
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
      if (matches.every(Boolean) && (options.afterFrameId === undefined || observation.snapshot.frameId > options.afterFrameId)) {
        return { observation, elapsedMs: now - started };
      }
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
    for (const controller of this.offline.values()) controller.abort();
    await Promise.allSettled([...this.offline.keys()]);
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
