import { randomUUID } from "node:crypto";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import { TuiLensError } from "../core/errors.js";
import { readBoundedFile } from "../core/bounded-file.js";
import type { ManagerOptions, TerminalEngine, TerminalSnapshot } from "../core/types.js";
import { createBrowserEngine } from "../engine/browser-engine.js";

const columns = z.number().int().min(2).max(500);
const rows = z.number().int().min(2).max(250);
const time = z.number().finite().min(0).max(7 * 24 * 60 * 60 * 1000);
const header = z.object({ type: z.literal("header"), version: z.literal(1), cols: columns, rows,
  images: z.enum(["off", "sixel", "iterm", "all"]) }).strict();
const event = z.discriminatedUnion("type", [
  z.object({ type: z.literal("output"), data: z.string().max(1024 * 1024), atMs: time }).strict(),
  z.object({ type: z.literal("resize"), cols: columns, rows, atMs: time }).strict(),
  z.object({ type: z.literal("input"), action: z.unknown(), atMs: time }).strict(),
  z.object({ type: z.literal("exit"), code: z.number().int(), atMs: time }).strict(),
  z.object({ type: z.literal("end"), truncated: z.boolean(), atMs: time }).strict(),
]);
export interface ReplayResult {
  snapshot: TerminalSnapshot;
  screenshot: { path: string; width: number; height: number; frameId: number };
  events: number;
  truncated: boolean;
}
export interface ReplayOptions { speed?: number; allowTruncated?: boolean; signal?: AbortSignal }

function aborted(): TuiLensError { return new TuiLensError("ABORTED", "回放已取消"); }

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw aborted();
}

/** 不修改引擎处理顺序；取消仅终止等待，并由外层主动关闭引擎打断后台操作。 */
function cancellable<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => { signal?.removeEventListener("abort", abort); reject(aborted()); };
    signal?.addEventListener("abort", abort, { once: true });
    operation.then(
      (value) => {
        signal?.removeEventListener("abort", abort);
        if (signal?.aborted) reject(aborted());
        else resolve(value);
      },
      (error: unknown) => {
        signal?.removeEventListener("abort", abort);
        reject(signal?.aborted ? aborted() : error);
      },
    );
    if (signal?.aborted) abort();
  });
}

function parseRecording(text: string, allowTruncated: boolean) {
  const content = text.trim();
  const first = content.indexOf("\n");
  if (first < 0) throw new TuiLensError("INCOMPLETE_RECORDING", "录制未包含结尾");
  let start: z.infer<typeof header>;
  const events: z.infer<typeof event>[] = [];
  let previous = 0;
  let cursor = first + 1;
  try {
    start = header.parse(JSON.parse(content.slice(0, first)));
    // 不先 split 整个文件；百万空行等输入不能越过事件数量上限分配对象。
    while (cursor < content.length) {
      if (events.length >= 100000) throw new TuiLensError("RECORDING_EVENT_LIMIT", "录制事件超过 100000 条");
      const next = content.indexOf("\n", cursor);
      const end = next < 0 ? content.length : next;
      const item = event.parse(JSON.parse(content.slice(cursor, end)));
      if (item.atMs < previous) throw new TuiLensError("INVALID_RECORDING", "录制时间戳未按序排列");
      if (item.type === "end" && end !== content.length) throw new TuiLensError("INVALID_RECORDING", "录制中存在提前结束标记");
      previous = item.atMs;
      events.push(item);
      cursor = end + 1;
    }
  } catch (error) {
    if (error instanceof TuiLensError) throw error;
    throw new TuiLensError("INVALID_RECORDING", "录制文件格式或版本不受支持");
  }
  const ending = events.at(-1);
  if (ending?.type !== "end") throw new TuiLensError("INCOMPLETE_RECORDING", "录制未结束，不能作为完整回放");
  if (ending.truncated && !allowTruncated) {
    throw new TuiLensError("TRUNCATED_RECORDING", "录制已截断，需显式允许部分回放");
  }
  return { start, events, truncated: ending.truncated };
}

async function closeBounded(engine: TerminalEngine): Promise<void> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      engine.close(),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new TuiLensError("REPLAY_CLEANUP_TIMEOUT", "回放引擎未在 5 秒内关闭")), 5000);
      }),
    ]);
  } finally { clearTimeout(timeout); }
}

/** 回放只应用输出和 resize，从不执行录制的命令、输入或其他文件中的代码。 */
export async function replayRecording(path: string, manager: ManagerOptions, options: ReplayOptions = {}): Promise<ReplayResult> {
  checkAbort(options.signal);
  const speed = options.speed ?? 0;
  if (!Number.isFinite(speed) || speed < 0 || speed > 100) throw new TuiLensError("INVALID_ARGUMENT", "回放速度须为 0–100，0 表示立即应用");
  const data = await readBoundedFile(path, 64 * 1024 * 1024);
  checkAbort(options.signal);
  const { start, events, truncated } = parseRecording(data.toString("utf8"), options.allowTruncated ?? false);
  checkAbort(options.signal);
  const engine = await (manager.engineFactory ?? createBrowserEngine)({
    cols: start.cols, rows: start.rows, images: start.images, onData: () => {},
    ...(manager.executablePath ? { executablePath: manager.executablePath } : {}),
    ...(manager.fontFamily ? { fontFamily: manager.fontFamily } : {}),
  });
  let closing: Promise<void> | undefined;
  const close = () => closing ??= closeBounded(engine);
  const onAbort = () => { void close().catch(() => undefined); };
  options.signal?.addEventListener("abort", onAbort, { once: true });
  let frameId = 0;
  let previous = 0;
  let result: ReplayResult | undefined;
  let failure: unknown;
  const artifacts: string[] = [];
  try {
    checkAbort(options.signal);
    for (const item of events) {
      checkAbort(options.signal);
      const delay = speed ? (item.atMs - previous) / speed : 0;
      if (delay > 30000) throw new TuiLensError("REPLAY_DELAY_LIMIT", "单步回放延迟超过 30 秒；可提高速度或使用 speed=0");
      if (delay) await cancellable(sleep(delay, undefined, options.signal ? { signal: options.signal } : {}), options.signal);
      checkAbort(options.signal);
      previous = item.atMs;
      if (item.type === "output") { await cancellable(engine.write(item.data), options.signal); frameId += 1; }
      if (item.type === "resize") { await cancellable(engine.resize(item.cols, item.rows), options.signal); frameId += 1; }
      checkAbort(options.signal);
    }
    checkAbort(options.signal);
    const snapshot = await cancellable(engine.snapshot(frameId), options.signal);
    checkAbort(options.signal);
    const capture = await cancellable(engine.screenshot(), options.signal);
    checkAbort(options.signal);
    await mkdir(manager.artifactDir, { recursive: true, mode: 0o700 });
    checkAbort(options.signal);
    const target = join(manager.artifactDir, `replay-${randomUUID()}.png`);
    artifacts.push(target);
    await writeFile(target, capture.png, { mode: 0o600 });
    checkAbort(options.signal);
    result = { snapshot, screenshot: { path: target, width: capture.width, height: capture.height, frameId },
      events: events.length, truncated };
    const metadata = target.replace(/\.png$/, ".json");
    artifacts.push(metadata);
    await writeFile(metadata, JSON.stringify(result, null, 2), { mode: 0o600 });
    checkAbort(options.signal);
  } catch (error) { failure = options.signal?.aborted ? aborted() : error; }
  finally {
    options.signal?.removeEventListener("abort", onAbort);
    try { await close(); }
    catch (error) {
      failure = failure
        ? new TuiLensError(options.signal?.aborted ? "ABORTED" : "REPLAY_CLEANUP_FAILED", "回放未完成且引擎清理失败",
          { cause: failure instanceof Error ? failure.message : String(failure),
            cleanup: error instanceof Error ? error.message : String(error) })
        : error;
    }
  }
  if (options.signal?.aborted && !failure) failure = aborted();
  if (failure) {
    for (const artifact of artifacts) await unlink(artifact).catch(() => undefined);
    throw failure;
  }
  if (!result) throw new TuiLensError("REPLAY_FAILED", "回放未生成结果");
  return result;
}
