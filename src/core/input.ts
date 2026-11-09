import { TuiLensError } from "./errors.js";
import type { InputAction, TerminalSnapshot } from "./types.js";
import { integer } from "./validation.js";

const CSI = "\x1b[";
const plainKeys: Record<string, string> = {
  enter: "\r", return: "\r", escape: "\x1b", esc: "\x1b",
  backspace: "\x7f", tab: "\t", space: " ",
  insert: `${CSI}2~`, delete: `${CSI}3~`,
  pageup: `${CSI}5~`, pagedown: `${CSI}6~`,
  f1: "\x1bOP", f2: "\x1bOQ", f3: "\x1bOR", f4: "\x1bOS",
  f5: `${CSI}15~`, f6: `${CSI}17~`, f7: `${CSI}18~`,
  f8: `${CSI}19~`, f9: `${CSI}20~`, f10: `${CSI}21~`,
  f11: `${CSI}23~`, f12: `${CSI}24~`,
};
const arrows: Record<string, string> = {
  up: "A", arrowup: "A", down: "B", arrowdown: "B",
  right: "C", arrowright: "C", left: "D", arrowleft: "D", home: "H", end: "F",
};

export function encodeKey(key: string, applicationCursorKeys: boolean): string {
  if (typeof key !== "string" || key.length === 0) {
    throw new TuiLensError("INVALID_ARGUMENT", "key 必须非空");
  }
  const parts = key.toLowerCase().split("+");
  const name = parts.pop() ?? "";
  const modifiers = new Set(parts);
  if (parts.some((part) => !["ctrl", "alt", "shift"].includes(part))) {
    throw new TuiLensError("UNSUPPORTED_KEY", `不支持的按键组合：${key}`);
  }
  const arrow = arrows[name];
  if (arrow) {
    if (modifiers.size === 0) return applicationCursorKeys ? `\x1bO${arrow}` : `${CSI}${arrow}`;
    const modifier = 1 + (modifiers.has("shift") ? 1 : 0) + (modifiers.has("alt") ? 2 : 0) + (modifiers.has("ctrl") ? 4 : 0);
    return `${CSI}1;${modifier}${arrow}`;
  }
  if (name === "tab" && modifiers.size === 1 && modifiers.has("shift")) return `${CSI}Z`;
  let value: string | undefined;
  if (modifiers.has("ctrl") && /^[a-z@\[\]\\^_]$/u.test(name)) {
    value = String.fromCharCode(name.toUpperCase().charCodeAt(0) & 0x1f);
  } else if (modifiers.has("ctrl")) {
    throw new TuiLensError("UNSUPPORTED_KEY", `不支持的 Ctrl 组合：${key}`);
  } else {
    value = plainKeys[name];
    if (value === undefined && [...name].length === 1) {
      value = modifiers.has("shift") ? name.toUpperCase() : name;
    } else if (modifiers.has("shift")) {
      throw new TuiLensError("UNSUPPORTED_KEY", `不支持的 Shift 组合：${key}`);
    }
  }
  if (value === undefined) throw new TuiLensError("UNSUPPORTED_KEY", `不支持的按键：${key}`);
  return modifiers.has("alt") ? `\x1b${value}` : value;
}

export function encodeInput(action: InputAction, snapshot: Pick<TerminalSnapshot, "cols" | "rows" | "modes">): string {
  if (!action || typeof action !== "object") throw new TuiLensError("INVALID_ARGUMENT", "无效输入操作");
  if (action.type === "text" || action.type === "paste" || action.type === "raw") {
    const value = action.type === "raw" ? action.data : action.text;
    if (typeof value !== "string" || Buffer.byteLength(value) > 1_048_576) {
      throw new TuiLensError("INVALID_ARGUMENT", "单次输入必须为不超过 1 MiB 的字符串");
    }
    if (action.type === "text" && /[\x00-\x1f\x7f]/u.test(value)) {
      throw new TuiLensError("INVALID_ARGUMENT", "text 不能包含控制字符；多行输入使用 paste");
    }
    if (action.type === "paste") {
      if (!snapshot.modes.bracketedPaste) {
        throw new TuiLensError("PASTE_NOT_ENABLED", "应用尚未启用括号粘贴；先聚焦输入框");
      }
      if (value.includes("\x1b")) {
        throw new TuiLensError("INVALID_ARGUMENT", "paste 不接受 ESC；原始控制序列应显式使用 raw");
      }
      return `${CSI}200~${value}${CSI}201~`;
    }
    return value;
  }
  if (action.type === "key") return encodeKey(action.key, snapshot.modes.applicationCursorKeys);
  if (!["click", "move", "scroll"].includes(action.type)) {
    throw new TuiLensError("INVALID_ARGUMENT", "不支持的输入操作");
  }
  integer(action.x, "x", 0, snapshot.cols - 1);
  integer(action.y, "y", 0, snapshot.rows - 1);
  if (snapshot.modes.mouseTracking === "none") {
    throw new TuiLensError("MOUSE_NOT_ENABLED", "应用尚未启用鼠标跟踪");
  }
  if (snapshot.modes.mouseEncoding !== "sgr") {
    throw new TuiLensError("UNSUPPORTED_MOUSE_PROTOCOL", "首版鼠标操作需要应用启用字符格 SGR 编码（1006）");
  }
  const position = `${action.x + 1};${action.y + 1}`;
  if (action.type === "move") return `${CSI}<35;${position}M`;
  if (action.type === "scroll") {
    integer(action.amount ?? 3, "amount", 1, 100);
    if (action.direction !== "up" && action.direction !== "down") {
      throw new TuiLensError("INVALID_ARGUMENT", "滚轮方向必须为 up 或 down");
    }
    return `${CSI}<${action.direction === "up" ? 64 : 65};${position}M`.repeat(action.amount ?? 3);
  }
  const button = action.button ?? "left";
  if (!["left", "middle", "right"].includes(button)) {
    throw new TuiLensError("INVALID_ARGUMENT", "无效鼠标按钮");
  }
  const code = { left: 0, middle: 1, right: 2 }[button];
  return `${CSI}<${code};${position}M${CSI}<${code};${position}m`;
}
