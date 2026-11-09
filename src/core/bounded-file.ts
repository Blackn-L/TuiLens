import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { TuiLensError } from "./errors.js";

const MAX_READ_LIMIT = 64 * 1024 * 1024;
const READ_CHUNK = 64 * 1024;

/**
 * 从同一个已打开的文件描述符检查和读取，避免 stat/readFile 间的路径替换。
 * Unix 以非阻塞方式打开，再拒绝 FIFO/设备；增长中的普通文件最多读取 limit+1。
 */
export async function readBoundedFile(path: string, maxBytes: number): Promise<Buffer> {
  if (typeof path !== "string" || !path || path.includes("\0")) {
    throw new TuiLensError("INVALID_FILE", "文件路径无效");
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_READ_LIMIT) {
    throw new TuiLensError("INVALID_ARGUMENT", "文件读取上限必须是 1～67108864 字节的整数");
  }
  const flags = constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NONBLOCK);
  let handle;
  try {
    handle = await open(path, flags);
  } catch (error) {
    throw new TuiLensError("INVALID_FILE", "无法打开普通文件", {
      reason: error instanceof Error ? error.message : String(error),
    });
  }
  try {
    const status = await handle.stat();
    if (!status.isFile()) throw new TuiLensError("INVALID_FILE", "只接受普通文件");
    if (status.size > maxBytes) throw new TuiLensError("FILE_LIMIT", "文件超过读取上限", { maxBytes });
    const chunks: Buffer[] = [];
    let size = 0;
    while (size <= maxBytes) {
      const chunk = Buffer.allocUnsafe(Math.min(READ_CHUNK, maxBytes + 1 - size));
      const result = await handle.read(chunk, 0, chunk.length, size);
      if (!result.bytesRead) return Buffer.concat(chunks, size);
      size += result.bytesRead;
      if (size > maxBytes) throw new TuiLensError("FILE_LIMIT", "文件在读取期间超过上限", { maxBytes });
      chunks.push(chunk.subarray(0, result.bytesRead));
    }
    throw new TuiLensError("FILE_LIMIT", "文件超过读取上限", { maxBytes });
  } catch (error) {
    if (error instanceof TuiLensError) throw error;
    throw new TuiLensError("INVALID_FILE", "普通文件读取失败", {
      reason: error instanceof Error ? error.message : String(error),
    });
  } finally {
    await handle.close();
  }
}
