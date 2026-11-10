import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolveExecutable } from "../src/core/executable.js";
import { TuiLensError } from "../src/core/errors.js";

const windows = process.platform === "win32";

test("POSIX 保留命令名，交给系统 PATH 查找", async () => {
  assert.deepEqual(await resolveExecutable("ssh", { cwd: "/tmp", env: {}, platform: "linux" }), {
    file: "ssh",
  });
});

test("Windows 裸命令按 PATH/PATHEXT 解析并优先原生可执行文件", { skip: !windows }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "tuilens-exec-"));
  try {
    await writeFile(join(directory, "tool.cmd"), "");
    await writeFile(join(directory, "tool.exe"), "");
    const resolved = await resolveExecutable("tool", {
      cwd: directory,
      env: { Path: directory, PATHEXT: ".CMD;.EXE" },
      platform: "win32",
    });
    assert.equal(resolved.file, join(directory, "tool.exe"));
    assert.equal(resolved.resolved, join(directory, "tool.exe"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Windows 显式相对/绝对路径可省略扩展名", { skip: !windows }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "tuilens-exec-path-"));
  try {
    const bin = join(directory, "bin");
    await mkdir(bin);
    await writeFile(join(bin, "tool.exe"), "");
    const relative = await resolveExecutable("bin\\tool", {
      cwd: directory,
      env: { PATHEXT: ".EXE" },
      platform: "win32",
    });
    assert.equal(relative.file, join(bin, "tool.exe"));
    const absolute = await resolveExecutable(join(bin, "tool"), {
      cwd: directory,
      env: { PATHEXT: ".EXE" },
      platform: "win32",
    });
    assert.equal(absolute.file, join(bin, "tool.exe"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("显式大小写 PATH 覆盖旧 Path 键", { skip: !windows }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "tuilens-exec-env-"));
  try {
    await writeFile(join(directory, "preferred.exe"), "");
    const resolved = await resolveExecutable("preferred", {
      cwd: directory,
      env: { Path: join(directory, "missing"), PATH: directory, PATHEXT: ".EXE" },
      platform: "win32",
    });
    assert.equal(resolved.file, join(directory, "preferred.exe"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Windows 缺失命令给出有界搜索详情", { skip: !windows }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "tuilens-exec-missing-"));
  try {
    await assert.rejects(
      resolveExecutable("missing-tuilens-bin", {
        cwd: directory,
        env: { PATH: directory, PATHEXT: ".EXE" },
        platform: "win32",
      }),
      (error: unknown) => error instanceof TuiLensError
        && error.code === "EXECUTABLE_NOT_FOUND"
        && Array.isArray((error.details as { searchDirectories?: unknown }).searchDirectories),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Windows 批处理脚本不被隐式包装", { skip: !windows }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "tuilens-exec-cmd-"));
  try {
    await writeFile(join(directory, "script.cmd"), "@echo off\r\n");
    await assert.rejects(
      resolveExecutable("script", {
        cwd: directory,
        env: { PATH: directory, PATHEXT: ".CMD" },
        platform: "win32",
      }),
      (error: unknown) => error instanceof TuiLensError && error.code === "EXECUTABLE_REQUIRES_SHELL",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
