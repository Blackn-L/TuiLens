import { mkdir, open, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import type { ImageProfile, InputAction } from "../core/types.js";
import type { RecordingTerminalProfile } from "./replay.js";
import { TuiLensError } from "../core/errors.js";

export interface RecordingHeader {
  type: "header";
  version: 1;
  cols: number;
  rows: number;
  images: ImageProfile;
  profile?: RecordingTerminalProfile;
}

function sanitizeRecordingHeader(header: RecordingHeader): RecordingHeader {
  if (!header.profile) return header;
  const { env: _env, source: _source, ...profile } = header.profile as RecordingTerminalProfile & {
    env?: Record<string, string>; source?: unknown;
  };
  return { ...header, profile };
}
export type RecordedEvent =
  | { type: "output"; data: string }
  | { type: "input"; action: InputAction }
  | { type: "resize"; cols: number; rows: number }
  | { type: "exit"; code: number };

/** 录制是显式选择的正文持久化，容量达到上限后停止记录并标注截断。 */
export class RecordingWriter {
  private bytes = 0;
  private truncated = false;
  private closed = false;
  private events = 0;
  private pending: Promise<void> = Promise.resolve();
  private closePromise: Promise<void> | undefined;
  private failure: unknown;
  private readonly started = performance.now();
  private constructor(
    readonly path: string,
    private readonly file: FileHandle,
    private readonly maxBytes: number,
  ) {}

  static async create(directory: string, id: string, header: RecordingHeader, maxBytes = 16 * 1024 * 1024) {
    if (!Number.isInteger(maxBytes) || maxBytes < 4096 || maxBytes > 64 * 1024 * 1024) {
      throw new TuiLensError("INVALID_RECORDING_LIMIT", "录制容量须为 4 KiB–64 MiB");
    }
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, `${id}.recording.jsonl`);
    const file = await open(path, "wx", 0o600);
    const writer = new RecordingWriter(path, file, maxBytes);
    try { await writer.line(sanitizeRecordingHeader(header)); } catch (error) { await file.close(); throw error; }
    return writer;
  }

  private async line(value: unknown): Promise<void> {
    const line = JSON.stringify(value) + "\n";
    await this.file.writeFile(line);
    this.bytes += Buffer.byteLength(line);
  }

  /** 已接收输出被丢弃、引擎故障或强制关闭时，调用方必须标记录制不完整。 */
  markTruncated(): void {
    this.truncated = true;
  }

  append(event: RecordedEvent): Promise<void> {
    if (this.closed || this.truncated) return Promise.resolve();
    const record = { ...event, atMs: Math.round(performance.now() - this.started) };
    const operation = this.pending.then(async () => {
      if (this.failure) throw this.failure;
      if (this.truncated) return;
      // 结尾保留空间和一个事件名额；不能生成自身无法完整回放的超限文件。
      if (this.events >= 99999 || this.bytes + Buffer.byteLength(JSON.stringify(record)) + 512 > this.maxBytes) {
        this.truncated = true;
        return;
      }
      await this.line(record);
      this.events += 1;
    });
    this.pending = operation.catch((error: unknown) => {
      this.failure ??= error;
      this.truncated = true;
    });
    return operation;
  }

  close(): Promise<void> {
    this.closePromise ??= this.finish();
    return this.closePromise;
  }

  private async finish(): Promise<void> {
    this.closed = true;
    // 等待已开始的文件写入，防止关闭与最后一批输出交错生成损坏的 JSON 行。
    await this.pending;
    try {
      await this.line({ type: "end", truncated: this.truncated, atMs: Math.round(performance.now() - this.started) });
    } finally { await this.file.close(); }
    if (this.failure) throw this.failure;
  }
}
