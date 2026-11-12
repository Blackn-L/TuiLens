import { TuiLensError } from "./errors.js";
import type { InputAction, KeyboardProtocol, Modifiers, TerminalState } from "./types.js";
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

/**
 * Kitty keyboard protocol 的 unicode-key-code。
 * `CSI <code> ; <modifier> u` 使用这些值；可打印字符直接使用其码位。
 */
const kittyCodes: Record<string, number> = {
  escape: 27, esc: 27, enter: 13, return: 13, tab: 9, backspace: 127, space: 32,
  insert: 57348, delete: 57349,
  left: 57350, arrowleft: 57350, right: 57351, arrowright: 57351,
  up: 57352, arrowup: 57352, down: 57353, arrowdown: 57353,
  pageup: 57354, pagedown: 57355, home: 57356, end: 57357,
  capslock: 57358, scrolllock: 57359, numlock: 57360,
  printscreen: 57361, pause: 57362, menu: 57363,
};
for (let index = 1; index <= 12; index += 1) kittyCodes[`f${index}`] = 57363 + index;
for (let index = 13; index <= 35; index += 1) kittyCodes[`f${index}`] = 57363 + index;

/** 1 + shift/alt/ctrl 位，与 CSI 1;<n>A 及 kitty/modifyOtherKeys 共用同一掩码。 */
function modifierValue(modifiers: Set<string>): number {
  return 1 + (modifiers.has("shift") ? 1 : 0) + (modifiers.has("alt") ? 2 : 0) + (modifiers.has("ctrl") ? 4 : 0);
}

function kittyEnabled(keyboard: KeyboardProtocol | undefined): boolean {
  // flag 1 消歧义，flag 8 把所有键都报告为转义序列。
  return keyboard?.kitty !== undefined && keyboard.kitty > 0;
}

/** Kitty 模式下的 CSI u；修饰键为 1 时省略参数。 */
function kittySequence(code: number, modifier: number): string {
  return modifier === 1 ? `${CSI}${code}u` : `${CSI}${code};${modifier}u`;
}

/** xterm modifyOtherKeys 的 CSI 27 ; <modifier> ; <code> ~ 形式。 */
function modifyOtherKeysSequence(code: number, modifier: number): string {
  return `${CSI}27;${modifier};${code}~`;
}

function codePointOf(name: string): number | undefined {
  const characters = [...name];
  return characters.length === 1 ? characters[0]!.codePointAt(0) : undefined;
}

export function encodeKey(key: string, applicationCursorKeys: boolean, keyboard?: KeyboardProtocol): string {
  if (typeof key !== "string" || key.length === 0) {
    throw new TuiLensError("INVALID_ARGUMENT", "key 必须非空");
  }
  const parts = key.toLowerCase().split("+");
  const name = parts.pop() ?? "";
  const modifiers = new Set(parts);
  if (parts.some((part) => !["ctrl", "alt", "shift"].includes(part))) {
    throw new TuiLensError("UNSUPPORTED_KEY", `不支持的按键组合：${key}`);
  }
  const modifier = modifierValue(modifiers);
  const kitty = kittyEnabled(keyboard);
  const otherKeys = keyboard?.modifyOtherKeys !== undefined && keyboard.modifyOtherKeys >= 2;
  const kittyCode = kittyCodes[name];
  const codePoint = codePointOf(name);

  // 现代协议：带修饰的功能键、Enter/Tab/Escape/Backspace/Space 以及带 Ctrl/Alt 的字符
  // 都需要与裸键区分的编码，否则应用无法区分 Shift+Enter 与 Enter。
  const functional = kittyCode !== undefined;
  const distinguished = modifiers.has("ctrl") || modifiers.has("alt");
  if (kitty && (functional || distinguished) && (modifier > 1 || functional)) {
    const code = kittyCode ?? codePoint;
    if (code !== undefined) return kittySequence(code, modifier);
  }
  if (otherKeys && modifier > 1) {
    const code = kittyCode ?? codePoint;
    // modifyOtherKeys 只覆盖 ASCII；功能键仍使用各自的 CSI 形式。
    // 已有传统控制字符编码的组合（Ctrl+字母 → C0）必须保持原样：
    // 应用普遍依赖 \x01 之类的字节，改写会破坏既有行为。
    const hasControlEncoding = modifiers.has("ctrl") && !modifiers.has("alt")
      && /^[a-z@\[\]\\^_]$/u.test(name);
    if (code !== undefined && code < 57344 && !hasControlEncoding) {
      return modifyOtherKeysSequence(code, modifier);
    }
  }

  const arrow = arrows[name];
  if (arrow) {
    if (modifiers.size === 0) return applicationCursorKeys ? `\x1bO${arrow}` : `${CSI}${arrow}`;
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
    if (value === undefined && codePoint !== undefined) {
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

/** 到达首/尾最多发送的滚轮事件数；与应用无关的上界，避免无限滚动。 */
const SCROLL_END_EVENTS = 2000;
/** 每批写入的事件数：让长滚动可被取消并给应用留出消费时间。 */
const SCROLL_END_BATCH = 100;

/**
 * 把 `scroll to:"top"|"bottom"` 拆成有界批次。
 *
 * 一次性向 PTY 写入 2000 个事件会对应用形成突发输入，
 * 也让操作无法在中间取消。返回 `undefined` 表示这不是到达端点的滚动。
 */
export function encodeScrollBatches(
  action: InputAction,
  state: TerminalState,
): string[] | undefined {
  if (action.type !== "scroll" || !("to" in action)) return undefined;
  const coordinates = position(action.x, action.y, state);
  const modifiers = modifierCode(action.modifiers);
  const code = (action.to === "top" ? 64 : 65) | modifiers;
  const event = mouseEvent(code, coordinates);
  const batches: string[] = [];
  for (let sent = 0; sent < SCROLL_END_EVENTS; sent += SCROLL_END_BATCH) {
    batches.push(event.repeat(Math.min(SCROLL_END_BATCH, SCROLL_END_EVENTS - sent)));
  }
  return batches;
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
  if (action.type === "key") {
    return encodeKey(action.key, snapshot.modes.applicationCursorKeys, snapshot.modes.keyboard);
  }
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
      const conflicting = action as typeof action & { direction?: unknown; unit?: unknown; amount?: unknown };
      if (conflicting.direction !== undefined || conflicting.unit !== undefined || conflicting.amount !== undefined) {
        throw new TuiLensError("INVALID_ARGUMENT", "滚动终点不能与方向、单位或数量同时使用");
      }
      if (action.to !== "top" && action.to !== "bottom") {
        throw new TuiLensError("INVALID_ARGUMENT", "滚动终点必须为 top 或 bottom");
      }
      // 到达端点由 encodeScrollBatches 分批发送；这里的同步编码只用于单批场景。
      return encodeScrollBatches(action, snapshot)!.join("");
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
