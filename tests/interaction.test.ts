import assert from "node:assert/strict";
import test from "node:test";
import * as nodePty from "node-pty";
import { encodeInput } from "../src/core/input.js";
import { findText, regionFingerprint } from "../src/core/locator.js";
import { inputGuard, launchOptions, waitOptions } from "../src/core/validation.js";
import type { InputAction, TerminalCell, TerminalSnapshot, TerminalState } from "../src/core/types.js";

const state: TerminalState = {
  cols: 20, rows: 8,
  modes: { alternateScreen: true, bracketedPaste: true,
    applicationCursorKeys: false, mouseTracking: "any", mouseEncoding: "sgr" },
};

function snapshot(): TerminalSnapshot {
  const makeCell = (x: number, y: number, text: string, width = 1): TerminalCell => ({
    x, y, text, width, fg: "#ffffff", bg: "#000000", bold: false,
    italic: false, underline: false, inverse: false,
  });
  const rows = [
    [makeCell(0, 0, "中", 2), makeCell(1, 0, "", 0), makeCell(2, 0, "🚀", 2), makeCell(3, 0, "", 0)],
    [makeCell(0, 1, "中", 2), makeCell(1, 1, "", 0), makeCell(2, 1, "🚀", 2), makeCell(3, 1, "", 0)],
  ];
  for (const cell of rows[1]!) {
    cell.bg = "#123456";
    cell.fg = "#aabbcc";
    cell.bold = true;
    cell.underline = true;
  }
  return {
    ...state, frameId: 1, capturedAt: "now", rows: 2, cols: 4,
    text: "中🚀\n中🚀", lines: ["中🚀", "中🚀"], cells: rows, cursor: { x: 0, y: 0 },
  };
}

test("SGR 修饰键适用于点击、滚轮与显式按下释放", () => {
  assert.equal(encodeInput({ type: "click", x: 2, y: 3,
    button: "right", modifiers: { shift: true, alt: true, ctrl: true } }, state),
  "\x1b[<30;3;4M\x1b[<30;3;4m");
  assert.equal(encodeInput({ type: "mouseDown", x: 0, y: 0, button: "middle",
    modifiers: { alt: true } }, state), "\x1b[<9;1;1M");
  assert.equal(encodeInput({ type: "mouseUp", x: 19, y: 7, button: "middle",
    modifiers: { alt: true } }, state), "\x1b[<9;20;8m");
  assert.equal(encodeInput({ type: "scroll", x: 3, y: 2, direction: "down", amount: 1,
    modifiers: { shift: true } }, state), "\x1b[<69;4;3M");
  assert.equal(encodeInput({ type: "move", x: 1, y: 1, modifiers: { ctrl: true } }, state),
    "\x1b[<51;2;2M");
});

test("拖拽覆盖两个端点并在末格释放同一按钮", () => {
  const result = encodeInput({
    type: "drag", from: { x: 0, y: 0 }, to: { x: 4, y: 2 }, steps: 2,
    modifiers: { shift: true, ctrl: true },
  }, state);
  assert.equal(result, "\x1b[<20;1;1M\x1b[<52;3;2M\x1b[<52;5;3M\x1b[<20;5;3m");
  assert.equal(encodeInput({
    type: "drag", from: { x: 3, y: 2 }, to: { x: 3, y: 2 }, steps: 10,
    button: "right",
  }, state), "\x1b[<2;4;3M\x1b[<2;4;3m");
  const long = encodeInput({
    type: "drag", from: { x: 0, y: 0 }, to: { x: 2, y: 0 }, steps: 100,
  }, state);
  assert.equal(long, "\x1b[<0;1;1M\x1b[<32;2;1M\x1b[<32;3;1M\x1b[<0;3;1m");
});

test("拖拽与修饰键非法参数不会产出半截操作", () => {
  assert.throws(() => encodeInput({ type: "drag", from: { x: 0, y: 0 },
    to: { x: 20, y: 1 } }, state), { code: "INVALID_ARGUMENT" });
  assert.throws(() => encodeInput({ type: "drag", from: { x: 0, y: 0 },
    to: { x: 1, y: 1 }, steps: 101 }, state), { code: "INVALID_ARGUMENT" });
  assert.throws(() => encodeInput({ type: "drag", from: { x: 0, y: 0 },
    to: { x: 1, y: 1 } }, { ...state, modes: { ...state.modes, mouseTracking: "vt200" } }),
    { code: "MOUSE_DRAG_NOT_ENABLED" });
  assert.throws(() => encodeInput({ type: "mouseDown", x: 0, y: 0 },
    { ...state, modes: { ...state.modes, mouseEncoding: "legacy" } }),
    { code: "UNSUPPORTED_MOUSE_PROTOCOL" });
  assert.throws(() => encodeInput({ type: "click", x: 0, y: 0,
    modifiers: { shift: "true" } } as unknown as InputAction, state), { code: "INVALID_ARGUMENT" });
});

test("样式过滤覆盖宽字符续格，选择按过滤后结果计数", () => {
  const screen = snapshot();
  assert.deepEqual(findText(screen, "中🚀", undefined, {
    style: { fg: "#AABBCC", bg: "#123456", bold: true, underline: true }, selection: "unique",
  })[0]?.region, { x: 0, y: 1, width: 4, height: 1 });
  assert.throws(() => findText(screen, "中🚀", undefined, { selection: "unique" }),
    { code: "AMBIGUOUS_MATCH" });
  assert.equal(findText(screen, "中🚀", undefined, { selection: "first" })[0]?.region.y, 0);
  assert.equal(findText(screen, "中🚀", undefined, { selection: "last" })[0]?.region.y, 1);
  assert.equal(findText(screen, "中🚀", undefined, { nth: 1 })[0]?.region.y, 1);
  screen.cells[1]![3]!.bold = false;
  assert.equal(findText(screen, "中🚀", undefined, { style: { bold: true } }).length, 0);
});

test("样式颜色按反色后的可见值匹配，限定区域不命中被切断的字符", () => {
  const screen = snapshot();
  for (const cell of screen.cells[1]!) cell.inverse = true;
  assert.equal(findText(screen, "中🚀", undefined, {
    style: { fg: "#123456", bg: "#aabbcc" }, selection: "unique",
  })[0]?.region.y, 1);
  assert.equal(findText(screen, "中", { x: 1, y: 0, width: 3, height: 2 }).length, 0);
  assert.equal(findText(screen, "🚀", { x: 0, y: 0, width: 3, height: 2 }).length, 0);
});

test("唯一匹配和序号匹配明确区分零结果与非法选项", () => {
  const screen = snapshot();
  assert.throws(() => findText(screen, "absent", undefined, { selection: "unique" }), { code: "NO_MATCH" });
  assert.throws(() => findText(screen, "中", undefined, { nth: 2 }), { code: "NO_MATCH" });
  assert.throws(() => findText(screen, "中", undefined, { nth: -1 }), { code: "INVALID_ARGUMENT" });
  assert.throws(() => findText(screen, "中", undefined, { selection: "unique", nth: 0 }), { code: "INVALID_ARGUMENT" });
  assert.throws(() => findText(screen, "中", undefined, { style: { fg: "red" } }), { code: "INVALID_ARGUMENT" });
  assert.deepEqual(findText(screen, "absent", undefined, { selection: "first" }), []);
});

test("新增启动、等待和保护条件有严格参数边界", () => {
  launchOptions({ command: "sample", images: "all", recording: { maxBytes: 4096 } });
  waitOptions({ conditions: [{ kind: "text", text: "中", style: { bold: false }, count: 2 }] });
  assert.throws(() => launchOptions({ command: "sample", recording: { maxBytes: 1 } }), { code: "INVALID_ARGUMENT" });
  assert.throws(() => launchOptions({ command: "sample", images: "unknown" as "off" }), { code: "INVALID_ARGUMENT" });
  assert.throws(() => waitOptions({ conditions: [{ kind: "text", text: "x", absent: true, count: 1 }] }), { code: "INVALID_ARGUMENT" });
  assert.throws(() => waitOptions({ conditions: [{ kind: "text", text: "x", style: { bold: "yes" as unknown as boolean } }] }), { code: "INVALID_ARGUMENT" });
  const screen = snapshot();
  const bounds = { x: 0, y: 0, width: 4, height: 1 };
  inputGuard({ frameId: 1, region: { bounds, fingerprint: regionFingerprint(screen, bounds) } }, 4, 2);
  assert.throws(() => inputGuard({ frameId: -1 }, 4, 2), { code: "INVALID_ARGUMENT" });
  assert.throws(() => inputGuard({ region: { bounds: { ...bounds, width: 5 }, fingerprint: "x" } }, 4, 2),
    { code: "INVALID_ARGUMENT" });
});

test("独立真实 PTY 程序收到完整拖拽和多行粘贴字节", { timeout: 15000 }, async () => {
  const packet = encodeInput({ type: "drag", from: { x: 1, y: 1 }, to: { x: 3, y: 2 },
    steps: 2, button: "right", modifiers: { shift: true } }, state)
    + encodeInput({ type: "paste", text: "中文\n🚀" }, state);
  const finish = "END_PACKET_821";
  const source = `
    process.stdin.setRawMode(true);
    let input = Buffer.alloc(0);
    process.stdin.on('data', data => {
      input = Buffer.concat([input, data]);
      const end = input.indexOf('${finish}');
      if (end >= 0) {
        process.stdout.write('RESULT:' + input.subarray(0, end).toString('base64') + '\\r\\n');
        process.stdin.pause();
        process.stdin.setRawMode(false);
      }
    });
    process.stdout.write('PTY_READY\\r\\n');
    process.stdin.resume();
  `;
  const pty = nodePty.spawn(process.execPath, ["-e", source], { name: "xterm-256color", cols: 160, rows: 20 });
  let output = "";
  let sent = false;
  let timer: NodeJS.Timeout | undefined;
  let resultSubscription: nodePty.IDisposable | undefined;
  let exitSubscription: nodePty.IDisposable | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error("PTY 输入验证超时")), 8000);
      resultSubscription = pty.onData((data) => {
        output += data;
        if (!sent && output.includes("PTY_READY")) {
          sent = true;
          pty.write(packet + finish);
        }
        const match = /RESULT:([A-Za-z0-9+/=]+)/u.exec(output);
        if (match) {
          try {
            assert.equal(Buffer.from(match[1]!, "base64").toString(), packet);
            resolve();
          } catch (error) { reject(error); }
        }
      });
      exitSubscription = pty.onExit(({ exitCode }) => {
        if (!output.includes("RESULT:")) reject(new Error(`PTY 提前退出：${exitCode}`));
      });
    });
  } finally {
    clearTimeout(timer);
    resultSubscription?.dispose();
    exitSubscription?.dispose();
    pty.kill();
  }
});
