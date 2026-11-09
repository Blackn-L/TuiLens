import { TuiLensError } from "./errors.js";
import type { LaunchOptions, Region, WaitOptions } from "./types.js";

export function integer(value: unknown, name: string, min: number, max: number): asserts value is number {
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    throw new TuiLensError("INVALID_ARGUMENT", `${name} 必须是 ${min}～${max} 的整数`);
  }
}

export function dimensions(cols: number, rows: number): void {
  integer(cols, "cols", 2, 500);
  integer(rows, "rows", 2, 250);
}

export function regionWithin(region: Region, cols: number, rows: number): void {
  integer(region.x, "region.x", 0, cols - 1);
  integer(region.y, "region.y", 0, rows - 1);
  integer(region.width, "region.width", 1, cols - region.x);
  integer(region.height, "region.height", 1, rows - region.y);
}

export function launchOptions(options: LaunchOptions): void {
  if (typeof options?.command !== "string" || options.command.length === 0 || options.command.includes("\0")) {
    throw new TuiLensError("INVALID_ARGUMENT", "command 必须是非空可执行程序路径或名称");
  }
  dimensions(options.cols ?? 160, options.rows ?? 50);
  if (options.args !== undefined && (!Array.isArray(options.args) ||
      options.args.some((arg) => typeof arg !== "string" || arg.includes("\0")))) {
    throw new TuiLensError("INVALID_ARGUMENT", "args 必须是字符串数组，且不能包含 NUL");
  }
  if (options.cwd !== undefined && (typeof options.cwd !== "string" || !options.cwd || options.cwd.includes("\0"))) {
    throw new TuiLensError("INVALID_ARGUMENT", "cwd 必须是有效目录路径");
  }
  if (options.env !== undefined && (typeof options.env !== "object" || options.env === null ||
      Array.isArray(options.env) || Object.entries(options.env).some(([key, value]) =>
        !key || key.includes("=") || key.includes("\0") || typeof value !== "string" || value.includes("\0")))) {
    throw new TuiLensError("INVALID_ARGUMENT", "env 必须是有效的环境变量字符串映射");
  }
  if (options.colorMode !== undefined && !["truecolor", "ansi256", "none"].includes(options.colorMode)) {
    throw new TuiLensError("INVALID_ARGUMENT", "不支持的 colorMode");
  }
}

export function waitOptions(options: WaitOptions): void {
  if (!options || !Array.isArray(options.conditions) || options.conditions.length === 0 || options.conditions.length > 20) {
    throw new TuiLensError("INVALID_ARGUMENT", "等待需要 1～20 个条件");
  }
  integer(options.timeoutMs ?? 10_000, "timeoutMs", 1, 300_000);
  for (const condition of options.conditions) {
    if (!condition || typeof condition !== "object") {
      throw new TuiLensError("INVALID_ARGUMENT", "无效等待条件");
    }
    switch (condition.kind) {
      case "text":
        if (typeof condition.text !== "string" || !condition.text) {
          throw new TuiLensError("INVALID_ARGUMENT", "等待文本必须非空");
        }
        break;
      case "stable":
        integer(condition.durationMs ?? 250, "durationMs", 1, 60_000);
        break;
      case "size":
        dimensions(condition.cols, condition.rows);
        break;
      case "exited":
        break;
      default:
        throw new TuiLensError("INVALID_ARGUMENT", "不支持的等待条件");
    }
  }
}
