import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execute = promisify(execFile);
const cli = fileURLToPath(new URL("../src/interfaces/cli.js", import.meta.url));

test("状态文件发布失败时服务退出，不留下半启动端点", { timeout: 15000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), "tuilens-start-fail-"));
  try {
    await mkdir(join(home, "daemon.json"));
    await assert.rejects(execute(process.execPath, [cli, "_serve"], {
      env: { ...process.env, TUILENS_HOME: home }, timeout: 5000,
    }), (error: unknown) => {
      const e = error as { code?: number; killed?: boolean; stdout?: string };
      assert.equal(e.killed, false, "必须自行退出，不能靠测试超时杀进程");
      assert.equal(e.code, 1);
      assert.match(e.stdout ?? "", /EISDIR|EPERM|illegal operation/u);
      return true;
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("并发自动启动只连接同一服务，关闭后可再次启动", { timeout: 30000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), "tuilens-start-race-"));
  const env = { ...process.env, TUILENS_HOME: home };
  const call = async (command: string) => {
    const result = await execute(process.execPath, [cli, command], { env, timeout: 15000 });
    return JSON.parse(result.stdout) as { ok: boolean; data: { pid: number } };
  };
  try {
    const responses = await Promise.all(Array.from({ length: 5 }, () => call("ping")));
    assert.ok(responses.every((r) => r.ok));
    assert.equal(new Set(responses.map((r) => r.data.pid)).size, 1);
    await call("shutdown");
    // shutdown 返回后端点关闭异步完成；探测旧 PID 消失再验证重启。
    for (let i = 0; i < 50; i += 1) {
      try { process.kill(responses[0]!.data.pid, 0); } catch { break; }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const restarted = await call("ping");
    assert.notEqual(restarted.data.pid, responses[0]!.data.pid);
  } finally {
    await call("shutdown").catch(() => undefined);
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
