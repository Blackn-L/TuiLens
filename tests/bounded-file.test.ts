import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { appendFile, mkdtemp, mkdir, open, rm, writeFile, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { readBoundedFile } from "../src/core/bounded-file.js";

async function withDirectory(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "tuilens-bounded-"));
  try { await run(directory); }
  finally {
    if (!resolve(directory).startsWith(resolve(tmpdir()) + "/") &&
        !resolve(directory).startsWith(resolve(tmpdir()) + "\\")) throw new Error("临时目录超出预期范围");
    await rm(directory, { recursive: true, force: true });
  }
}

test("有界读取保留完整普通文件，允许恰好达到上限与空文件", async () => {
  await withDirectory(async (directory) => {
    const path = join(directory, "sample.bin");
    const bytes = Buffer.alloc(180_000, 0x9b);
    await writeFile(path, bytes);
    assert.deepEqual(await readBoundedFile(path, bytes.length), bytes);
    assert.deepEqual(await readBoundedFile(path, bytes.length + 500), bytes);
    await writeFile(path, "");
    assert.equal((await readBoundedFile(path, 1)).length, 0);
  });
});

test("超限文件、目录、无效路径及无效限额使用明确错误", async () => {
  await withDirectory(async (directory) => {
    const path = join(directory, "sample.bin");
    await writeFile(path, Buffer.alloc(1024));
    await assert.rejects(readBoundedFile(path, 1023), { code: "FILE_LIMIT" });
    await assert.rejects(readBoundedFile(directory, 1024), { code: "INVALID_FILE" });
    await assert.rejects(readBoundedFile(join(directory, "missing"), 1024), { code: "INVALID_FILE" });
    await assert.rejects(readBoundedFile("", 1024), { code: "INVALID_FILE" });
    for (const limit of [0, -1, 1.1, Infinity, NaN, 64 * 1024 * 1024 + 1]) {
      await assert.rejects(readBoundedFile(path, limit), { code: "INVALID_ARGUMENT" });
    }
    // 重复失败后仍能删除，Windows 下也用于检查文件句柄确实关闭。
    await assert.rejects(readBoundedFile(path, 1), { code: "FILE_LIMIT" });
    await rm(path);
    await mkdir(path);
  });
});

test("Unix FIFO 和设备在打开后立即拒绝，不等待写入者", {
  skip: process.platform === "win32",
  timeout: 5000,
}, async () => {
  await withDirectory(async (directory) => {
    const fifo = join(directory, "pipe");
    await promisify(execFile)("mkfifo", [fifo]);
    const started = performance.now();
    await assert.rejects(readBoundedFile(fifo, 1024), { code: "INVALID_FILE" });
    await assert.rejects(readBoundedFile("/dev/zero", 1024), { code: "INVALID_FILE" });
    assert.ok(performance.now() - started < 2000);
  });
});

test("初次 fstat 后增长的文件仍按 limit+1 拒绝，并释放描述符", async (context) => {
  await withDirectory(async (directory) => {
    const path = join(directory, "growing.bin");
    await writeFile(path, Buffer.alloc(64));
    const sample = await open(path, "r");
    const prototype = Object.getPrototypeOf(sample) as { read: FileHandle["read"] };
    await sample.close();
    type Read = (this: FileHandle, buffer: Buffer, offset: number, length: number,
      position: number) => Promise<{ bytesRead: number; buffer: Buffer }>;
    const original = prototype.read as Read;
    let changed = false;
    context.mock.method(prototype, "read", async function (
      this: FileHandle, buffer: Buffer, offset: number, length: number, position: number,
    ) {
      if (!changed) {
        changed = true;
        // 首次 read 必然晚于读取函数内部的 fstat，确定性模拟文件增长。
        await appendFile(path, Buffer.alloc(65));
      }
      return original.call(this, buffer, offset, length, position);
    });
    try {
      await assert.rejects(readBoundedFile(path, 128), { code: "FILE_LIMIT" });
      assert.equal(changed, true);
    } finally { context.mock.restoreAll(); }
    await rm(path);
  });
});
