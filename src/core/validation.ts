import { TuiLensError } from "./errors.js";
import type {
  ClickTextOptions, InputGuard, LaunchOptions, MatchOptions, MatchStyle, Region, WaitOptions,
} from "./types.js";

function object(value: unknown, label: string): asserts value is object {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TuiLensError("INVALID_ARGUMENT", `${label} 必须是对象`);
  }
}

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
  object(region, "region");
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
    throw new TuiLensError("INVALID_ARGUMENT", "colorMode 必须是 truecolor、ansi256 或 none", {
      received: options.colorMode,
    });
  }
  if (options.images !== undefined && !["off", "sixel", "iterm", "all"].includes(options.images)) {
    throw new TuiLensError("INVALID_ARGUMENT", "不支持的 images");
  }
  if (options.graphics !== undefined) {
    object(options.graphics, "graphics");
    if (Object.keys(options.graphics).some((key) => !["sixel", "kitty", "iterm"].includes(key))) {
      throw new TuiLensError("INVALID_ARGUMENT", "graphics 含未知字段");
    }
    for (const [key, value] of Object.entries(options.graphics)) {
      if (typeof value !== "boolean") {
        throw new TuiLensError("INVALID_ARGUMENT", `graphics.${key} 必须是布尔值`);
      }
    }
  }
  if (options.terminalProfile !== undefined
    && (typeof options.terminalProfile !== "string" || !options.terminalProfile.trim()
      || options.terminalProfile.includes("\0"))) {
    throw new TuiLensError("INVALID_ARGUMENT", "terminalProfile 必须是非空 preset 名称或文件路径");
  }
  if (options.recording !== undefined) {
    object(options.recording, "recording");
    if (Object.keys(options.recording).some((key) => key !== "maxBytes")) {
      throw new TuiLensError("INVALID_ARGUMENT", "recording 含未知字段");
    }
    if (options.recording.maxBytes !== undefined) integer(options.recording.maxBytes, "recording.maxBytes", 4096, 64 * 1024 * 1024);
  }
  if (options.protocolReplies !== undefined) {
    object(options.protocolReplies, "protocolReplies");
    if (Object.keys(options.protocolReplies).some((key) => !["mode", "maxLatencyMs"].includes(key))) {
      throw new TuiLensError("INVALID_ARGUMENT", "protocolReplies 含未知字段");
    }
    if (options.protocolReplies.mode !== undefined
      && !["auto", "forward", "suppress"].includes(options.protocolReplies.mode)) {
      throw new TuiLensError("INVALID_ARGUMENT", "不支持的 protocolReplies.mode");
    }
    if (options.protocolReplies.maxLatencyMs !== undefined) {
      integer(options.protocolReplies.maxLatencyMs, "protocolReplies.maxLatencyMs", 0, 5000);
    }
  }
}

export function matchStyle(style: MatchStyle | undefined): void {
  if (style === undefined) return;
  object(style, "style");
  for (const [key, value] of Object.entries(style)) {
    if (key === "fg" || key === "bg") {
      if (typeof value !== "string" || !/^#[\da-f]{6}$/iu.test(value)) {
        throw new TuiLensError("INVALID_ARGUMENT", `${key} 必须是 #RRGGBB 色值`);
      }
    } else if (["bold", "italic", "underline"].includes(key)) {
      if (typeof value !== "boolean") throw new TuiLensError("INVALID_ARGUMENT", `${key} 必须是布尔值`);
    } else {
      throw new TuiLensError("INVALID_ARGUMENT", `未知样式字段：${key}`);
    }
  }
}

export function matchOptions(options: MatchOptions): void {
  object(options, "匹配选项");
  if (Object.keys(options).some((key) => !["style", "selection", "nth"].includes(key))) {
    throw new TuiLensError("INVALID_ARGUMENT", "匹配选项含未知字段");
  }
  matchStyle(options.style);
  if (options.selection !== undefined && !["all", "unique", "first", "last"].includes(options.selection)) {
    throw new TuiLensError("INVALID_ARGUMENT", "不支持的 selection");
  }
  if (options.nth !== undefined) {
    integer(options.nth, "nth", 0, Number.MAX_SAFE_INTEGER);
    if (options.selection !== undefined && options.selection !== "all") {
      throw new TuiLensError("INVALID_ARGUMENT", "nth 不能与 unique、first 或 last 同时使用");
    }
  }
}

export function clickTextOptions(options: ClickTextOptions | undefined): void {
  if (options === undefined) return;
  object(options, "点击选项");
  const { allowPendingFrame, hitbox, point, offset, button, modifiers, ...matching } = options;
  matchOptions(matching);
  if (allowPendingFrame !== undefined && typeof allowPendingFrame !== "boolean") {
    throw new TuiLensError("INVALID_ARGUMENT", "allowPendingFrame 必须是布尔值");
  }
  if (hitbox !== undefined) {
    object(hitbox, "hitbox");
    if (Object.keys(hitbox).some((key) => !["left", "right", "top", "bottom"].includes(key))) {
      throw new TuiLensError("INVALID_ARGUMENT", "hitbox 含未知字段");
    }
    if (hitbox.left !== undefined) integer(hitbox.left, "hitbox.left", 0, 500);
    if (hitbox.right !== undefined) integer(hitbox.right, "hitbox.right", 0, 500);
    if (hitbox.top !== undefined) integer(hitbox.top, "hitbox.top", 0, 250);
    if (hitbox.bottom !== undefined) integer(hitbox.bottom, "hitbox.bottom", 0, 250);
  }
  if (point !== undefined && !["center", "left", "right", "top", "bottom"].includes(point)) {
    throw new TuiLensError("INVALID_ARGUMENT", "不支持的点击位置");
  }
  if (offset !== undefined) {
    object(offset, "offset");
    if (Object.keys(offset).some((key) => !["x", "y"].includes(key))) {
      throw new TuiLensError("INVALID_ARGUMENT", "offset 含未知字段");
    }
    if (offset.x !== undefined) integer(offset.x, "offset.x", -500, 500);
    if (offset.y !== undefined) integer(offset.y, "offset.y", -250, 250);
  }
  if (button !== undefined && !["left", "middle", "right"].includes(button)) {
    throw new TuiLensError("INVALID_ARGUMENT", "无效鼠标按钮");
  }
  if (modifiers !== undefined) {
    object(modifiers, "modifiers");
    if (Object.entries(modifiers).some(([key, value]) => !["shift", "alt", "ctrl"].includes(key) || typeof value !== "boolean")) {
      throw new TuiLensError("INVALID_ARGUMENT", "modifiers 只接受 shift、alt、ctrl 布尔值");
    }
  }
}

/** frameId 与区域指纹可同时声明；区域边界在实际操作时按当前终端尺寸检查。 */
export function inputGuard(guard: InputGuard | undefined, cols: number, rows: number): void {
  if (guard === undefined) return;
  object(guard, "guard");
  if (Object.keys(guard).some((key) => !["frameId", "region"].includes(key))) {
    throw new TuiLensError("INVALID_ARGUMENT", "guard 含未知字段");
  }
  if (guard.frameId !== undefined) integer(guard.frameId, "guard.frameId", 0, Number.MAX_SAFE_INTEGER);
  if (guard.region !== undefined) {
    object(guard.region, "guard.region");
    if (Object.keys(guard.region).some((key) => !["bounds", "fingerprint"].includes(key))) {
      throw new TuiLensError("INVALID_ARGUMENT", "guard.region 含未知字段");
    }
    regionWithin(guard.region.bounds, cols, rows);
    if (typeof guard.region.fingerprint !== "string" || !guard.region.fingerprint
      || Buffer.byteLength(guard.region.fingerprint) > 64 * 1024 * 1024) {
      throw new TuiLensError("INVALID_ARGUMENT", "guard.region.fingerprint 必须是非空且大小有界的字符串");
    }
  }
}

export function waitOptions(options: WaitOptions): void {
  if (options?.afterFrameId !== undefined) integer(options.afterFrameId, "afterFrameId", 0, Number.MAX_SAFE_INTEGER);
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
        if (typeof condition.text !== "string" || !condition.text || /[\r\n]/u.test(condition.text)) {
          throw new TuiLensError("INVALID_ARGUMENT", "等待文本必须非空且不能跨行");
        }
        if (condition.absent !== undefined && typeof condition.absent !== "boolean") {
          throw new TuiLensError("INVALID_ARGUMENT", "absent 必须是布尔值");
        }
        matchStyle(condition.style);
        if (condition.count !== undefined) {
          integer(condition.count, "count", 0, 125000);
          if (condition.absent === true && condition.count !== 0) {
            throw new TuiLensError("INVALID_ARGUMENT", "absent 与非零 count 冲突");
          }
        }
        break;
      case "stable":
        integer(condition.durationMs ?? 250, "durationMs", 1, 60_000);
        break;
      case "size":
        dimensions(condition.cols, condition.rows);
        break;
      case "cursor": {
        const fields = [
          condition.x !== undefined,
          condition.y !== undefined,
          condition.visible !== undefined,
          condition.style !== undefined,
          condition.blink !== undefined,
        ];
        if (!fields.some(Boolean)) throw new TuiLensError("INVALID_ARGUMENT", "cursor 条件至少需要一个字段");
        if (condition.x !== undefined) integer(condition.x, "cursor.x", 0, 499);
        if (condition.y !== undefined) integer(condition.y, "cursor.y", 0, 249);
        if (condition.style !== undefined && !["block", "underline", "bar"].includes(condition.style)) {
          throw new TuiLensError("INVALID_ARGUMENT", "不支持的 cursor.style");
        }
        if (condition.visible !== undefined && typeof condition.visible !== "boolean") {
          throw new TuiLensError("INVALID_ARGUMENT", "cursor.visible 必须是布尔值");
        }
        if (condition.blink !== undefined && typeof condition.blink !== "boolean") {
          throw new TuiLensError("INVALID_ARGUMENT", "cursor.blink 必须是布尔值");
        }
        break;
      }
      case "exited":
        break;
      default:
        throw new TuiLensError("INVALID_ARGUMENT", "不支持的等待条件");
    }
  }
}
