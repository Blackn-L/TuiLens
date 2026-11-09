/**
 * 原生 PTY 开销对照。测量期间不截图、不轮询字符格；最后一帧只用于正确性校验。
 * CPU/RSS 明确只统计工具根进程，Chromium、ConPTY 与 workload 是独立进程。
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { cpus, platform, release, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import type { IPty } from "node-pty";
import type { EngineFactory, TerminalEngine } from "../src/core/types.js";

const SELF = fileURLToPath(import.meta.url);
const COLS = 160;
const ROWS = 50;
const TIMEOUT_MS = 120_000;
const DEFAULTS = { frames: 240, repeats: 3, paceMs: 0 };
type Mode = "drain-only" | "tuilens";
interface Options { frames: number; repeats: number; paceMs: number; out: string }
interface FixtureResult {
  frames: number;
  producedBytes: number;
  elapsedMs: number;
  cpu: NodeJS.CpuUsage;
  maxRssBytes: number;
}
interface SessionMetrics {
  receivedBytes: number;
  appliedBytes: number;
  pendingBytes: number;
  peakPendingBytes: number;
  pauseCount: number;
}
interface Result {
  mode: Mode;
  startupMs: number;
  startupRootCpuMs: number;
  workload: FixtureResult;
  tool: {
    controlToOutputAppliedMs: number;
    controlToExitObservedMs: number;
    rootCpuMs: number;
    rootRssStartBytes: number;
    rootRssPeakBytes: number;
    rootRssEndBytes: number;
    rssSamplingIntervalMs: number;
    receivedBytes: number;
    appliedBytes: number;
    observedChunks: number;
    sessionMetrics: SessionMetrics | null;
  };
  validation: { completionMarkerReceived: true; finalScreenContainsMarker: boolean | null; exitCode: number };
  workerDiagnostics?: string;
}

function option(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} 缺少参数`);
  return value;
}

function numberOption(args: string[], flag: string, fallback: number, min: number, max: number): number {
  const value = Number(option(args, flag) ?? fallback);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${flag} 必须为 ${min}–${max} 的整数`);
  return value;
}

function parseOptions(args: string[]): Options {
  const allowed = new Set(["--frames", "--repeats", "--pace-ms", "--out"]);
  for (let index = 0; index < args.length; index += 2) {
    if (!allowed.has(args[index]!)) throw new Error(`未知参数：${args[index]}`);
  }
  return {
    frames: numberOption(args, "--frames", DEFAULTS.frames, 1, 100_000),
    repeats: numberOption(args, "--repeats", DEFAULTS.repeats, 1, 20),
    paceMs: numberOption(args, "--pace-ms", DEFAULTS.paceMs, 0, 1000),
    out: resolve(option(args, "--out") ?? "artifacts/overhead.json"),
  };
}

function cpuMs(cpu: NodeJS.CpuUsage): number { return (cpu.user + cpu.system) / 1000; }
function rounded(value: number): number { return Math.round(value * 1000) / 1000; }

async function until(predicate: () => boolean, label: string): Promise<void> {
  const deadline = performance.now() + TIMEOUT_MS;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error(`等待超时：${label}`);
    await sleep(10);
  }
}

/** stdout 回调保证字节交给通道；耗时仍可能受 PTY 背压影响，正是本对照需要观察的量。 */
function writeStdout(data: string): Promise<void> {
  return new Promise((resolveWrite, reject) => process.stdout.write(data, (error) => {
    if (error) reject(error); else resolveWrite();
  }));
}

async function fixture(args: string[]): Promise<void> {
  const frames = Number(args[0]);
  const paceMs = Number(args[1]);
  const reportPath = args[2]!;
  const token = args[3]!;
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("fixture 必须运行在真实 PTY 中");
  process.stdin.setRawMode(true);
  process.stdin.resume();
  const ready = new Promise<void>((resolveReady) => {
    let pending = "";
    const onData = (data: Buffer): void => {
      pending += data.toString();
      if (pending.includes("GO\r")) {
        process.stdin.off("data", onData);
        resolveReady();
      }
    };
    process.stdin.on("data", onData);
  });
  await writeStdout(`\x1b[?25l\x1b[2J\x1b[HREADY_${token}\r\n`);
  await ready;
  // 每帧改变整行内容，避免 ConPTY 将重复画面优化成只有标题更新。
  const frameBodies = Array.from({ length: 26 }, (_, frame) => Array.from({ length: 45 }, (_, index) => {
    const payload = String.fromCharCode(65 + frame).repeat(128);
    return `\x1b[${index + 3};1H\x1b[38;2;${40 + index};170;220mROW_${String(index).padStart(3, "0")} 中文 🚀 ⠀ ${payload}\x1b[0m`;
  }).join(""));
  const started = performance.now();
  const cpuStarted = process.cpuUsage();
  let producedBytes = 0;
  for (let index = 0; index < frames; index += 1) {
    const data = `\x1b[H\x1b[2KFRAME_${String(index).padStart(6, "0")}\r\n${frameBodies[index % 26]}`;
    producedBytes += Buffer.byteLength(data);
    await writeStdout(data);
    if (paceMs) await sleep(paceMs);
  }
  const done = `\x1b[H\x1b[2KDONE_${token}\x1b[0m`;
  producedBytes += Buffer.byteLength(done);
  await writeStdout(done);
  const result: FixtureResult = {
    frames, producedBytes, elapsedMs: rounded(performance.now() - started),
    cpu: process.cpuUsage(cpuStarted),
    // Node resourceUsage 的 maxRSS 在支持的平台以 KiB 返回。
    maxRssBytes: process.resourceUsage().maxRSS * 1024,
  };
  await writeFile(reportPath, JSON.stringify(result));
  process.stdin.pause();
  process.stdin.setRawMode(false);
}

function benchmarkEnv(): Record<string, string> {
  const env = Object.fromEntries(Object.entries(process.env).filter(
    (entry): entry is [string, string] => entry[1] !== undefined,
  ));
  delete env.FORCE_COLOR;
  delete env.NO_COLOR;
  delete env.TERM_PROGRAM;
  delete env.KITTY_WINDOW_ID;
  delete env.WEZTERM_PANE;
  return { ...env, TERM: "xterm-256color", COLORTERM: "truecolor" };
}

async function worker(mode: Mode, frames: number, paceMs: number): Promise<Result> {
  const workdir = await mkdtemp(join(tmpdir(), "tuilens-overhead-"));
  const token = randomUUID().replaceAll("-", "");
  const reportPath = join(workdir, "fixture.json");
  const fixtureArgs = [SELF, "--fixture", String(frames), String(paceMs), reportPath, token];
  let tail = "";
  let ready = false;
  let done = false;
  let receivedBytes = 0;
  let appliedBytes = 0;
  let observedChunks = 0;
  let lastAppliedAt = 0;
  let exited: number | undefined;
  let pty: IPty | undefined;
  let engine: TerminalEngine | undefined;
  let close: (() => Promise<void>) | undefined;
  let send: (() => Promise<void>) | undefined;
  let getMetrics: (() => SessionMetrics) | undefined;
  let hasExited: (() => boolean) | undefined;
  let timer: NodeJS.Timeout | undefined;
  const listeners: { dispose(): void }[] = [];
  const startupStarted = performance.now();
  const startupCpu = process.cpuUsage();
  const collect = (data: string): void => {
    observedChunks += 1;
    receivedBytes += Buffer.byteLength(data);
    tail = (tail + data).slice(-65536);
    ready ||= tail.includes(`READY_${token}`);
    done ||= tail.includes(`DONE_${token}`);
  };
  try {
    if (mode === "drain-only") {
      const nodePty = await import("node-pty");
      pty = nodePty.spawn(process.execPath, fixtureArgs, {
        cwd: process.cwd(), cols: COLS, rows: ROWS, name: "xterm-256color", env: benchmarkEnv(),
      });
      listeners.push(pty.onData((data) => {
        collect(data);
        appliedBytes += Buffer.byteLength(data);
        lastAppliedAt = performance.now();
      }));
      listeners.push(pty.onExit(({ exitCode }) => { exited = exitCode; }));
      send = async () => { pty!.write("GO\r"); };
      hasExited = () => exited !== undefined;
      close = async () => {
        for (const listener of listeners) listener.dispose();
        // Windows 的退出事件到达后仍可能持有 PTY 管道，明确释放宿主资源。
        try { pty!.kill(); } catch (error) {
          if (exited === undefined) throw error;
        }
      };
    } else {
      const { SessionManager } = await import("../src/session/manager.js");
      const { createBrowserEngine } = await import("../src/engine/browser-engine.js");
      const engineFactory: EngineFactory = async (options) => {
        const actual = await createBrowserEngine(options);
        engine = actual;
        return {
          ...actual,
          async write(data) {
            collect(data);
            await actual.write(data);
            appliedBytes += Buffer.byteLength(data);
            lastAppliedAt = performance.now();
          },
        };
      };
      const manager = new SessionManager({ artifactDir: workdir, engineFactory });
      close = () => manager.closeAll();
      const session = await manager.launch({
        command: process.execPath, args: fixtureArgs, cols: COLS, rows: ROWS,
        env: benchmarkEnv(), cwd: process.cwd(),
      });
      const metricsManager = manager as typeof manager & { metrics(id: string): SessionMetrics };
      if (typeof metricsManager.metrics !== "function") throw new Error("当前 SessionManager 尚未提供 metrics()，不能伪造排队/背压指标");
      getMetrics = () => metricsManager.metrics(session.id);
      send = async () => { await manager.input(session.id, { type: "raw", data: "GO\r" }); };
      hasExited = () => {
        const info = manager.list().find((item) => item.id === session.id);
        if (info?.status === "exited") {
          exited = info.exitCode ?? -1;
          return true;
        }
        return false;
      };
    }
    await until(() => {
      if (!ready && hasExited!()) throw new Error(`fixture 在 READY 前退出 (${exited})：${tail.slice(-4000)}`);
      return ready;
    }, "fixture READY");
    const startupMs = performance.now() - startupStarted;
    const startupRootCpuMs = cpuMs(process.cpuUsage(startupCpu));
    const rootRssStartBytes = process.memoryUsage.rss();
    let peakRss = rootRssStartBytes;
    timer = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage.rss()); }, 25);
    const controlStarted = performance.now();
    const controlCpu = process.cpuUsage();
    await send!();
    await until(() => {
      if (!done || !hasExited!()) return false;
      const metrics = getMetrics?.();
      return !metrics || (metrics.pendingBytes === 0 && metrics.receivedBytes === metrics.appliedBytes);
    }, "完整输出已应用且进程退出");
    const end = performance.now();
    const rootCpuMs = cpuMs(process.cpuUsage(controlCpu));
    clearInterval(timer);
    timer = undefined;
    const rootRssEndBytes = process.memoryUsage.rss();
    peakRss = Math.max(peakRss, rootRssEndBytes);
    const metrics = getMetrics?.() ?? null;
    const workload = JSON.parse(await readFile(reportPath, "utf8")) as FixtureResult;
    if (exited !== 0) throw new Error(`fixture 退出码不是 0：${exited}`);
    let finalScreenContainsMarker: boolean | null = null;
    if (engine) {
      // 正确性检查在主测量窗口结束后执行一次，避免采集自身改变基准。
      const snapshot = await engine.snapshot(0);
      finalScreenContainsMarker = snapshot.text.includes(`DONE_${token}`);
      if (!finalScreenContainsMarker) throw new Error("终端最终画面未包含完成标记");
    }
    return {
      mode,
      startupMs: rounded(startupMs),
      startupRootCpuMs: rounded(startupRootCpuMs),
      workload,
      tool: {
        controlToOutputAppliedMs: rounded(lastAppliedAt - controlStarted),
        controlToExitObservedMs: rounded(end - controlStarted),
        rootCpuMs: rounded(rootCpuMs), rootRssStartBytes,
        rootRssPeakBytes: peakRss, rootRssEndBytes, rssSamplingIntervalMs: 25,
        receivedBytes: metrics?.receivedBytes ?? receivedBytes,
        appliedBytes: metrics?.appliedBytes ?? appliedBytes,
        observedChunks, sessionMetrics: metrics,
      },
      validation: { completionMarkerReceived: true, finalScreenContainsMarker, exitCode: exited },
    };
  } finally {
    if (timer) clearInterval(timer);
    await close?.();
    // 只移除本次 mkdtemp 创建的目录，Windows 同样先检查最终绝对路径。
    if (dirname(resolve(workdir)) !== resolve(tmpdir()) || !basename(workdir).startsWith("tuilens-overhead-")) {
      throw new Error("拒绝清理不属于本次基准的目录");
    }
    await rm(workdir, { recursive: true, force: true });
  }
}

async function subprocess(mode: Mode, options: Options): Promise<Result> {
  return new Promise((resolveWorker, reject) => {
    const child = spawn(process.execPath, [SELF, "--worker", mode, String(options.frames), String(options.paceMs)], {
      stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (data: string) => { stdout += data; });
    child.stderr.on("data", (data: string) => { stderr = (stderr + data).slice(-8192); });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code !== 0) { reject(new Error(`${mode} 基准失败 (${code})：${stderr}`)); return; }
      try {
        const result = JSON.parse(stdout) as Result;
        // 成功退出不抹去宿主清理诊断，便于区分测量通过与平台兼容问题。
        if (stderr.trim()) result.workerDiagnostics = stderr.trim();
        resolveWorker(result);
      } catch (error) { reject(error); }
    });
  });
}

async function main(options: Options): Promise<void> {
  const rounds: { repeat: number; results: Result[] }[] = [];
  for (let repeat = 0; repeat < options.repeats; repeat += 1) {
    const order: Mode[] = repeat % 2 ? ["tuilens", "drain-only"] : ["drain-only", "tuilens"];
    const results: Result[] = [];
    for (const mode of order) {
      process.stderr.write(`第 ${repeat + 1}/${options.repeats} 轮：${mode}\n`);
      results.push(await subprocess(mode, options));
    }
    if (results[0]!.workload.producedBytes !== results[1]!.workload.producedBytes) {
      throw new Error("两种模式的 fixture 产出字节数不一致，不能比较");
    }
    rounds.push({ repeat: repeat + 1, results });
  }
  const median = (values: number[]): number => {
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
  };
  const summary = Object.fromEntries((["drain-only", "tuilens"] as const).map((mode) => {
    const results = rounds.flatMap((round) => round.results).filter((result) => result.mode === mode);
    return [mode, {
      medianStartupMs: rounded(median(results.map((result) => result.startupMs))),
      medianWorkloadMs: rounded(median(results.map((result) => result.workload.elapsedMs))),
      medianOutputAppliedMs: rounded(median(results.map((result) => result.tool.controlToOutputAppliedMs))),
      medianToolRootCpuMs: rounded(median(results.map((result) => result.tool.rootCpuMs))),
      peakToolRootRssBytes: Math.max(...results.map((result) => result.tool.rootRssPeakBytes)),
    }];
  }));
  const report = {
    schemaVersion: 1, createdAt: new Date().toISOString(),
    environment: { node: process.version, platform: platform(), release: release(), arch: process.arch,
      cpuModel: cpus()[0]?.model ?? "unknown", logicalCpus: cpus().length,
      grid: { cols: COLS, rows: ROWS }, browserPath: process.env.TUILENS_BROWSER_PATH ?? "system auto selection" },
    settings: { frames: options.frames, repeats: options.repeats, paceMs: options.paceMs },
    boundaries: [
      "drain-only 不解析/绘制，不代表正常终端用户体验。",
      "工具 CPU/RSS 仅统计基准 worker 根进程，不含 Chromium、ConPTY 和 workload。",
      "截图关闭，完整状态仅在主测量窗口结束后读取一次以验证最终完成标记。",
      "启动含模块加载、浏览器/PTY 启动及 fixture READY，单独记录。",
      "控制到输出应用耗时包含 GO 输入调用和最后一次 parser write 返回，不代表屏幕像素已绘制。",
      "退出观察每 10ms 读取内存计数或生命周期，带来最多一轮轮询的计时误差。",
      "输出字节包含终端通道改写和 READY；workload.producedBytes 为 fixture 自身测量窗口的输出。",
      "根进程 RSS 每 25ms 采样，短峰值可能未被采到。",
      "该短期合成输出对照不能替代真实长任务的延迟、进程树资源及内存增长测试。",
    ],
    summary, rounds,
  };
  await mkdir(dirname(options.out), { recursive: true });
  await writeFile(options.out, JSON.stringify(report, null, 2));
  process.stdout.write(JSON.stringify({ path: options.out, summary }, null, 2) + "\n");
}

try {
  const args = process.argv.slice(2);
  if (args[0] === "--fixture") await fixture(args.slice(1));
  else if (args[0] === "--worker") {
    const mode = args[1];
    if (mode !== "drain-only" && mode !== "tuilens") throw new Error("未知 worker 模式");
    const result = await worker(mode, Number(args[2]), Number(args[3]));
    process.stdout.write(JSON.stringify(result) + "\n");
  } else await main(parseOptions(args));
} catch (error) {
  process.stderr.write((error instanceof Error ? error.stack : String(error)) + "\n");
  process.exitCode = 1;
}
