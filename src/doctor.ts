import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright";
import { errorRecord } from "./core/errors.js";
import { pick } from "./core/i18n.js";
import { resolveBrowserExecutable } from "./engine/browser-engine.js";
import { request } from "./transport/client.js";
import { runtimePaths } from "./transport/paths.js";
import { VERSION } from "./version.js";

export type DoctorStatus = "ok" | "warn" | "error";

export interface DoctorCheck {
  code: string;
  status: DoctorStatus;
  message: string;
  details?: Record<string, unknown>;
}

export interface DoctorReport {
  ok: boolean;
  status: DoctorStatus;
  version: string;
  generatedAt: string;
  durationMs: number;
  summary: Record<DoctorStatus, number>;
  checks: DoctorCheck[];
}

function check(code: string, status: DoctorStatus, message: string,
  details?: Record<string, unknown>): DoctorCheck {
  return { code, status, message, ...(details === undefined ? {} : { details }) };
}

function nodeCheck(): DoctorCheck {
  const major = Number.parseInt(process.versions.node, 10);
  return major >= 22
    ? check("runtime.node", "ok", pick("Node.js meets the minimum version.", "Node.js 版本满足要求。"), {
      node: process.versions.node,
    })
    : check("runtime.node", "error", pick("TuiLens requires Node.js 22 or newer.", "TuiLens 需要 Node.js 22 或更高版本。"), {
      node: process.versions.node,
    });
}

function platformCheck(): DoctorCheck {
  const supported = process.platform === "win32" || process.platform === "linux";
  if (supported) {
    return check("runtime.platform", "ok", pick("This platform is supported and covered by CI.", "当前平台受支持，并且有 CI 覆盖。"), {
      platform: process.platform,
      arch: process.arch,
    });
  }
  return check("runtime.platform", process.platform === "darwin" ? "warn" : "error",
    process.platform === "darwin"
      ? pick("macOS is covered by CI but remains experimental.", "macOS 已有 CI 覆盖，但仍属实验性支持。")
      : pick("This platform is not currently supported.", "当前平台暂不受支持。"), {
    platform: process.platform,
    arch: process.arch,
  });
}

async function browserCheck(): Promise<DoctorCheck> {
  const configured = process.env.TUILENS_BROWSER_PATH;
  if (configured) {
    return existsSync(configured)
      ? check("browser", "ok", pick("The configured browser exists.", "已配置的浏览器文件存在。"), {
        path: configured,
        source: "environment",
      })
      : check("browser", "error", pick("TUILENS_BROWSER_PATH points to a missing file.", "TUILENS_BROWSER_PATH 指向的文件不存在。"), {
        path: configured,
        source: "environment",
      });
  }

  try {
    const system = resolveBrowserExecutable();
    if (system) {
      return check("browser", "ok", pick("A system Chrome or Edge installation was found.", "已找到系统 Chrome 或 Edge。"), {
        path: system,
        source: "system",
      });
    }
  } catch (error) {
    return check("browser", "error", pick("The system browser could not be resolved.", "无法解析系统浏览器。"), {
      reason: error instanceof Error ? error.message : String(error),
    });
  }

  try {
    const bundled = chromium.executablePath();
    if (existsSync(bundled)) {
      return check("browser", "ok", pick("Playwright's Chromium installation was found.", "已找到 Playwright Chromium。"), {
        path: bundled,
        source: "playwright",
      });
    }
    return check("browser", "error",
      pick("No browser was found. Install Chrome/Edge or run npx playwright install chromium.",
        "未找到浏览器。请安装 Chrome/Edge，或运行 npx playwright install chromium。"), {
        path: bundled,
        source: "playwright",
      });
  } catch (error) {
    return check("browser", "error",
      pick("No browser was found. Install Chrome/Edge or run npx playwright install chromium.",
        "未找到浏览器。请安装 Chrome/Edge，或运行 npx playwright install chromium。"), {
        reason: error instanceof Error ? error.message : String(error),
      });
  }
}

async function ptyCheck(): Promise<DoctorCheck> {
  try {
    // 只验证原生模块能否加载；真实进程生命周期由 npm test 的 PTY 用例覆盖。
    const pty = await import("node-pty");
    if (typeof pty.spawn !== "function") throw new Error("node-pty does not expose spawn()");
    return check("pty", "ok", pick("node-pty loaded and exposes the PTY spawn API.", "node-pty 已加载，并提供 PTY spawn 接口。"));
  } catch (error) {
    return check("pty", "error", pick("node-pty could not be loaded.", "node-pty 无法加载。"), {
      reason: error instanceof Error ? error.message : String(error),
      hint: pick("Run npm ci and install the platform C++ build tools if needed.",
        "请运行 npm ci；必要时安装平台 C++ 构建工具。"),
    });
  }
}

async function storageCheck(paths: ReturnType<typeof runtimePaths>): Promise<DoctorCheck> {
  const probe = join(paths.artifactDir, `.doctor-${process.pid}-${randomUUID()}`);
  try {
    await mkdir(paths.home, { recursive: true, mode: 0o700 });
    await mkdir(paths.artifactDir, { recursive: true, mode: 0o700 });
    await writeFile(probe, "ok", { mode: 0o600 });
    await rm(probe, { force: true });
    return check("storage", "ok", pick("Runtime and artifact directories are writable.", "运行目录和证据目录可写。"), {
      home: paths.home,
      artifactDir: paths.artifactDir,
    });
  } catch (error) {
    await rm(probe, { force: true }).catch(() => undefined);
    return check("storage", "error", pick("Runtime or artifact storage is not writable.", "运行目录或证据目录不可写。"), {
      home: paths.home,
      artifactDir: paths.artifactDir,
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

async function daemonCheck(paths: ReturnType<typeof runtimePaths>): Promise<DoctorCheck> {
  if (!existsSync(paths.state)) {
    return check("daemon", "ok", pick("The daemon is not running; it will start on demand.", "daemon 当前未运行，将在需要时自动启动。"), {
      running: false,
      state: paths.state,
    });
  }
  try {
    const ping = await request("ping", {}, { autoStart: false, timeoutMs: 1500 }) as Record<string, unknown>;
    return check("daemon", "ok", pick("The daemon is running and responding.", "daemon 正在运行并能正常响应。"), {
      running: true,
      state: paths.state,
      ...ping,
    });
  } catch (error) {
    const record = errorRecord(error);
    return check("daemon", "warn",
      pick("Daemon state exists, but the endpoint is unavailable; the next request will start a new daemon.",
        "daemon 状态文件存在，但端点不可用；下一次请求会启动新的 daemon。"), {
        running: false,
        state: paths.state,
        reason: record.code,
      });
  }
}

/**
 * 本地诊断不启动 daemon，也不执行用户程序。
 *
 * 检查值与错误码保持稳定，便于脚本读取；`ok=false` 只表示存在会阻止基本运行
 * 的错误，警告（例如陈旧的 daemon 状态文件）仍按可自愈处理。
 */
export async function runDoctor(): Promise<DoctorReport> {
  const started = performance.now();
  const paths = runtimePaths();
  const [browser, pty, storage, daemon] = await Promise.all([
    browserCheck(),
    ptyCheck(),
    storageCheck(paths),
    daemonCheck(paths),
  ]);
  const checks = [nodeCheck(), platformCheck(), browser, pty, storage, daemon];
  const summary: Record<DoctorStatus, number> = { ok: 0, warn: 0, error: 0 };
  for (const item of checks) summary[item.status] += 1;
  const status: DoctorStatus = summary.error > 0 ? "error" : summary.warn > 0 ? "warn" : "ok";
  return {
    ok: summary.error === 0,
    status,
    version: VERSION,
    generatedAt: new Date().toISOString(),
    durationMs: Math.round(performance.now() - started),
    summary,
    checks,
  };
}
