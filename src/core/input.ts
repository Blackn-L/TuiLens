import { TuiLensError } from "./errors.js";
import type { InputAction, Modifiers, TerminalState } from "./types.js";
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

function modifierCode(modifiers: Modifiers | undefined): number {
  if (modifiers === undefined) return 0;
  if (!modifiers || typeof modifiers !== "object" || Array.isArray(modifiers)
    || Object.entries(modifiers).some(([key, value]) =>
      !["shift", "alt", "ctrl"].includes(key) || typeof value !== "boolean")) {
    throw new TuiLensError("INVALID_ARGUMENT", "modifiers 只接受 shift、alt、ctrl 布尔值");
  }
  return (modifiers.shift ? 4 : 0) | (modifiers.alt ? 8 : 0) | (modifiers.ctrl ? 16 : 0);
}

function buttonCode(button: "left" | "middle" | "right" | undefined): number {
  if (button !== undefined && !["left", "middle", "right"].includes(button)) {
    throw new TuiLensError("INVALID_ARGUMENT", "无效鼠标按钮");
  }
  return { left: 0, middle: 1, right: 2 }[button ?? "left"];
}

function position(x: number, y: number, state: TerminalState): string {
  integer(x, "x", 0, state.cols - 1);
  integer(y, "y", 0, state.rows - 1);
  return `${x + 1};${y + 1}`;
}

function mouseEvent(code: number, coordinates: string, release = false): string {
  return `${CSI}<${code};${coordinates}${release ? "m" : "M"}`;
}

function encodeDrag(action: Extract<InputAction, { type: "drag" }>, state: TerminalState): string {
  if (!action.from || !action.to) throw new TuiLensError("INVALID_ARGUMENT", "拖拽需要 from 和 to 坐标");
  const start = position(action.from.x, action.from.y, state);
  const end = position(action.to.x, action.to.y, state);
  if (!["drag", "any"].includes(state.modes.mouseTracking)) {
    throw new TuiLensError("MOUSE_DRAG_NOT_ENABLED", "应用尚未启用拖拽或任意移动跟踪");
  }
  const dx = action.to.x - action.from.x;
  const dy = action.to.y - action.from.y;
  const steps = action.steps ?? Math.min(32, Math.max(1, Math.abs(dx), Math.abs(dy)));
  integer(steps, "steps", 1, 100);
  const code = buttonCode(action.button) | modifierCode(action.modifiers);
  const events = [mouseEvent(code, start)];
  let previous = start;
  // 拖拽按下后逐格发送 button-motion，最后释放同一按钮；跳过取整产生的重复格。
  for (let step = 1; step <= steps; step += 1) {
    const coordinates = position(
      Math.round(action.from.x + dx * step / steps),
      Math.round(action.from.y + dy * step / steps),
      state,
    );
    if (coordinates !== previous) events.push(mouseEvent(code | 32, coordinates));
    previous = coordinates;
  }
  events.push(mouseEvent(code, end, true));
  return events.join("");
}

export function encodeInput(action: InputAction, snapshot: TerminalState): string {
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
  if (!["click", "move", "scroll", "mouseDown", "mouseUp", "drag"].includes(action.type)) {
    throw new TuiLensError("INVALID_ARGUMENT", "不支持的输入操作");
  }
  // 先校验全部参数，再返回完整序列，避免非法终点造成只按下未释放。
  if (action.type !== "drag") position(action.x, action.y, snapshot);
  if (snapshot.modes.mouseTracking === "none") {
    throw new TuiLensError("MOUSE_NOT_ENABLED", "应用尚未启用鼠标跟踪");
  }
  if (snapshot.modes.mouseEncoding !== "sgr") {
    throw new TuiLensError("UNSUPPORTED_MOUSE_PROTOCOL", "鼠标操作需要应用启用字符格 SGR 编码（1006）");
  }
  if (action.type === "drag") return encodeDrag(action, snapshot);
  const coordinates = position(action.x, action.y, snapshot);
  const modifiers = modifierCode(action.modifiers);
  if (action.type === "move") return mouseEvent(35 | modifiers, coordinates);
  if (action.type === "scroll") {
    if ("to" in action) {
      if (action.to !== "top" && action.to !== "bottom") {
        throw new TuiLensError("INVALID_ARGUMENT", "滚动终点必须为 top 或 bottom");
      }
      if (action.to === "top") return mouseEvent(64 | modifiers, coordinates).repeat(2000);
      return mouseEvent(65 | modifiers, coordinates).repeat(2000);
    }
    if (action.unit !== undefined && action.unit !== "line" && action.unit !== "page") {
      throw new TuiLensError("INVALID_ARGUMENT", "滚动单位必须为 line 或 page");
    }
    const amount = (action.amount ?? 3) * (action.unit === "page" ? snapshot.rows : 1);
    integer(action.amount ?? 3, "amount", 1, 100);
    if (action.direction !== "up" && action.direction !== "down") {
      throw new TuiLensError("INVALID_ARGUMENT", "滚轮方向必须为 up 或 down");
    }
    return mouseEvent((action.direction === "up" ? 64 : 65) | modifiers, coordinates).repeat(amount);
  }
  const code = buttonCode(action.button) | modifiers;
  if (action.type === "mouseDown") return mouseEvent(code, coordinates);
  if (action.type === "mouseUp") return mouseEvent(code, coordinates, true);
  return mouseEvent(code, coordinates) + mouseEvent(code, coordinates, true);
}
