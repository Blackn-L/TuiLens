import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { runDoctor } from "../src/doctor.js";
import { VERSION } from "../src/version.js";

const execute = promisify(execFile);
const cli = fileURLToPath(new URL("../src/interfaces/cli.js", import.meta.url));

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

test("doctor 聚合运行时、浏览器、PTY、存储和 idle daemon 状态", { timeout: 30_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), "tuilens-doctor-"));
  const previousHome = process.env.TUILENS_HOME;
  const previousBrowser = process.env.TUILENS_BROWSER_PATH;
  process.env.TUILENS_HOME = home;
  // 只验证路径解析和可读性；真实浏览器启动由 browser-engine 回归覆盖。
  process.env.TUILENS_BROWSER_PATH = process.execPath;
  try {
    const report = await runDoctor();
    assert.equal(report.ok, true);
    assert.ok(report.status === "ok" || report.status === "warn");
    assert.equal(report.version, VERSION);
    assert.equal(report.checks.find((item) => item.code === "runtime.node")?.status, "ok");
    assert.ok(["ok", "warn"].includes(
      report.checks.find((item) => item.code === "runtime.platform")?.status ?? "",
    ));
    assert.equal(report.checks.find((item) => item.code === "browser")?.status, "ok");
    assert.equal(report.checks.find((item) => item.code === "pty")?.status, "ok");
    assert.equal(report.checks.find((item) => item.code === "storage")?.status, "ok");
    assert.equal(report.checks.find((item) => item.code === "daemon")?.status, "ok");
    assert.equal(report.summary.error, 0);

    const result = await execute(process.execPath, [cli, "doctor"], {
      env: { ...process.env, TUILENS_HOME: home, TUILENS_BROWSER_PATH: process.execPath },
      maxBuffer: 1024 * 1024,
    });
    const payload = JSON.parse(result.stdout) as { ok: boolean; data: { version: string } };
    assert.equal(payload.ok, true);
    assert.equal(payload.data.version, VERSION);
  } finally {
    restoreEnv("TUILENS_HOME", previousHome);
    restoreEnv("TUILENS_BROWSER_PATH", previousBrowser);
    await rm(home, { recursive: true, force: true });
  }
});

test("doctor 报告缺失浏览器与陈旧 daemon 状态", { timeout: 30_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), "tuilens-doctor-stale-"));
  const previousHome = process.env.TUILENS_HOME;
  const previousBrowser = process.env.TUILENS_BROWSER_PATH;
  process.env.TUILENS_HOME = home;
  process.env.TUILENS_BROWSER_PATH = join(home, "missing-browser");
  try {
    await writeFile(join(home, "daemon.json"), "{not json", "utf8");
    const report = await runDoctor();
    assert.equal(report.ok, false);
    assert.equal(report.status, "error");
    assert.equal(report.checks.find((item) => item.code === "browser")?.status, "error");
    assert.equal(report.checks.find((item) => item.code === "daemon")?.status, "warn");
    assert.equal(report.summary.error, 1);
    assert.ok(report.summary.warn >= 1);

    const failure = await execute(process.execPath, [cli, "doctor"], {
      env: { ...process.env, TUILENS_HOME: home, TUILENS_BROWSER_PATH: process.env.TUILENS_BROWSER_PATH },
      maxBuffer: 1024 * 1024,
    }).then(() => undefined, (error: unknown) => error) as { code?: number; stdout?: string };
    assert.equal(failure.code, 1);
    const payload = JSON.parse(failure.stdout ?? "{}") as { ok: boolean; data: { ok: boolean; status: string } };
    assert.equal(payload.ok, true);
    assert.equal(payload.data.ok, false);
    assert.equal(payload.data.status, "error");
  } finally {
    restoreEnv("TUILENS_HOME", previousHome);
    restoreEnv("TUILENS_BROWSER_PATH", previousBrowser);
    await rm(home, { recursive: true, force: true });
  }
});
