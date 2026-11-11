import { execFile } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { promisify } from "node:util";

const run = promisify(execFile);

/** 进程树的一次快照。`rssBytes` 为整棵树的常驻内存合计。 */
export interface ProcessTreeSample {
  atMs: number;
  rootRssBytes: number;
  rssBytes: number;
  processes: number;
}

interface ProcessRecord {
  pid: number;
  parentPid: number;
  rssBytes: number;
}

/** Linux 直接读 /proc，避免为每次采样启动子进程。 */
async function linuxProcesses(): Promise<ProcessRecord[]> {
  const entries = await readdir("/proc");
  const records: ProcessRecord[] = [];
  for (const entry of entries) {
    if (!/^\d+$/u.test(entry)) continue;
    try {
      const status = await readFile(`/proc/${entry}/status`, "utf8");
      const pid = Number(entry);
      const parent = /^PPid:\s+(\d+)/mu.exec(status);
      const rss = /^VmRSS:\s+(\d+)\s+kB/mu.exec(status);
      if (!parent || !rss) continue;
      records.push({ pid, parentPid: Number(parent[1]), rssBytes: Number(rss[1]) * 1024 });
    } catch { /* 进程可能在读取期间退出。 */ }
  }
  return records;
}

/** Windows 用一次 CIM 查询取回全部进程的父子关系与工作集。 */
async function windowsProcesses(): Promise<ProcessRecord[]> {
  const script = "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,WorkingSetSize | ConvertTo-Json -Compress";
  const { stdout } = await run("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
    maxBuffer: 16 * 1024 * 1024, timeout: 10_000, windowsHide: true,
  });
  const parsed = JSON.parse(stdout.trim() || "[]") as unknown;
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  return rows.flatMap((row) => {
    if (!row || typeof row !== "object") return [];
    const item = row as { ProcessId?: unknown; ParentProcessId?: unknown; WorkingSetSize?: unknown };
    if (typeof item.ProcessId !== "number" || typeof item.ParentProcessId !== "number") return [];
    return [{
      pid: item.ProcessId,
      parentPid: item.ParentProcessId,
      rssBytes: typeof item.WorkingSetSize === "number" ? item.WorkingSetSize : 0,
    }];
  });
}

async function snapshotProcesses(): Promise<ProcessRecord[]> {
  if (process.platform === "linux") return linuxProcesses();
  if (process.platform === "win32") return windowsProcesses();
  // macOS 及其他平台退化为只统计根进程，并在报告里由 `processes` 字段体现。
  return [{ pid: process.pid, parentPid: 0, rssBytes: process.memoryUsage.rss() }];
}

/**
 * 按固定间隔采样一个进程树的内存峰值。
 *
 * 采样本身有开销（Windows 上单次约数百毫秒），因此默认间隔为 1 秒，
 * 并且只记录峰值与采样次数；报告需要显式标注采样间隔，
 * 以免把低频采样当作真实峰值。
 */
export class ProcessTreeSampler {
  private readonly samples: ProcessTreeSample[] = [];
  private timer: NodeJS.Timeout | undefined;
  private readonly started = performance.now();
  private inFlight: Promise<void> | undefined;
  private peak = 0;
  private peakProcesses = 0;
  private errors = 0;
  private lastError: string | undefined;

  constructor(
    private readonly rootPid: number,
    private readonly intervalMs = 1000,
  ) {}

  start(): void {
    // 立即采一次，短会话也能获得至少一个数据点。
    void this.sample();
    this.timer ??= setInterval(() => { void this.sample(); }, this.intervalMs);
    // 采样不应阻止进程退出。
    this.timer.unref?.();
  }

  /**
   * 停止采样并返回本段的聚合结果。
   * 必须等待仍在进行的采样，否则短会话会得到 0 个样本。
   */
  async stop(): Promise<ReturnType<ProcessTreeSampler["result"]>> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.inFlight;
    // 会话可能已结束；最终采样失败不影响已收集的数据。
    await this.sample();
    return this.result();
  }

  private sample(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.collect().finally(() => { this.inFlight = undefined; });
    return this.inFlight;
  }

  private async collect(): Promise<void> {
    try {
      const records = await snapshotProcesses();
      const tree = collectTree(records, this.rootPid);
      const rssBytes = tree.reduce((sum, record) => sum + record.rssBytes, 0);
      if (rssBytes > this.peak) this.peak = rssBytes;
      this.peakProcesses = Math.max(this.peakProcesses, tree.length);
      const root = tree.find((record) => record.pid === this.rootPid);
      this.samples.push({
        atMs: Math.round(performance.now() - this.started),
        rootRssBytes: root?.rssBytes ?? 0,
        rssBytes,
        processes: tree.length,
      });
    } catch (error) {
      // 采样失败不能使被测场景失败，但原因必须可见，否则报告中只是沉默的 0。
      this.errors += 1;
      this.lastError = error instanceof Error ? error.message : String(error);
    }
  }

  result(): {
    peakRssBytes: number;
    peakProcesses: number;
    samples: number;
    errors: number;
    lastError?: string;
    intervalMs: number;
    timeline: ProcessTreeSample[];
  } {
    return {
      peakRssBytes: this.peak,
      peakProcesses: this.peakProcesses,
      samples: this.samples.length,
      errors: this.errors,
      ...(this.lastError === undefined ? {} : { lastError: this.lastError }),
      intervalMs: this.intervalMs,
      timeline: this.samples.slice(-240),
    };
  }
}

/** 从根 pid 出发收集整棵子树；不存在的 pid 返回空数组。 */
export function collectTree(records: ProcessRecord[], rootPid: number): ProcessRecord[] {
  const byParent = new Map<number, ProcessRecord[]>();
  for (const record of records) {
    const siblings = byParent.get(record.parentPid) ?? [];
    siblings.push(record);
    byParent.set(record.parentPid, siblings);
  }
  const result: ProcessRecord[] = [];
  const queue = [rootPid];
  const seen = new Set<number>();
  while (queue.length) {
    const pid = queue.shift()!;
    if (seen.has(pid)) continue;
    seen.add(pid);
    const record = records.find((item) => item.pid === pid);
    if (record) result.push(record);
    for (const child of byParent.get(pid) ?? []) queue.push(child.pid);
  }
  return result;
}
