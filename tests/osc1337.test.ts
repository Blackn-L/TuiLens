import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PNG } from "pngjs";
import { chromium } from "playwright";
import { Osc1337Normalizer } from "../src/engine/osc1337.js";
import { createBrowserEngine, resolveBrowserExecutable } from "../src/engine/browser-engine.js";
import { SessionManager } from "../src/session/manager.js";
import { launchSchema } from "../src/core/protocol.js";
import { launchOptions } from "../src/core/validation.js";

const ESC = "\x1b";
const osc = (value: string, end = "\x07") => `${ESC}]1337;${value}${end}`;
function picture() {
  const png = new PNG({ width: 16, height: 12 });
  for (let i = 0; i < png.data.length; i += 4) png.data.set([255, 0, 0, 255], i);
  return PNG.sync.write(png);
}
function redPixels(buffer: Buffer) {
  const png = PNG.sync.read(buffer);
  let total = 0;
  for (let i = 0; i < png.data.length; i += 4) {
    if (png.data[i] === 255 && png.data[i + 1] === 0 && png.data[i + 2] === 0) total += 1;
  }
  return total;
}

test("IIP 归一化支持可选 size、BEL/ST 和任意字节块边界", () => {
  const data = picture(), encoded = data.toString("base64");
  const value = osc(`File=inline=1;width=16px;height=12px:${encoded}`, `${ESC}\\`);
  const parser = new Osc1337Normalizer();
  const result = [...value].map((part) => parser.write(part)).join("");
  assert.equal(result, osc(`File=inline=1;width=16px;height=12px;preserveAspectRatio=0;size=${data.length}:${encoded}`));
  assert.equal(parser.write("AFTER"), "AFTER");
  assert.equal(parser.write(osc("SetMark")), "");
  assert.equal(parser.write(osc(`File=inline=0;size=${data.length}:${encoded}`)), "");
  assert.equal(parser.write(`${ESC}]0;ordinary title\x07`), `${ESC}]0;ordinary title\x07`);
  assert.ok(parser.write(`\x9d1337;File=inline=1:${encoded}\x9c`).startsWith(`${ESC}]1337;File=inline=1;size=`));
  assert.equal(parser.write(`\x9d1337;File=inline=0:${encoded}\x9c`), "");
});

test("IIP MultipartFile 组装有界，重置和错误不会混入后续图像", () => {
  const encoded = picture().toString("base64");
  const parser = new Osc1337Normalizer();
  assert.equal(parser.write(osc("MultipartFile=inline=1")), "");
  assert.equal(parser.write(osc(`FilePart=${encoded.slice(0, 17)}`)), "");
  assert.equal(parser.write(osc(`FilePart=${encoded.slice(17)}`)), "");
  assert.match(parser.write(osc("FileEnd")), /^\x1b\]1337;File=inline=1;size=\d+:/);
  assert.equal(parser.write(osc("FileEnd")), "");
  parser.write(osc("MultipartFile=inline=1"));
  parser.write(osc(`FilePart=${encoded.slice(0, 12)}`));
  parser.write("\x1bc");
  assert.equal(parser.write(osc("FileEnd")), "");
  assert.equal(parser.write(osc("File=inline=1;size=8388609:AAAA")), "");
  assert.equal(parser.write(osc("File=inline=1;size=4:@@@@")), "");
  assert.ok(parser.write(osc(`File=inline=1:${encoded}`)).includes(encoded));
});

test("IIP 超大序列被丢弃后解析器恢复，拒绝超像素图片", () => {
  const parser = new Osc1337Normalizer();
  parser.write(`${ESC}]1337;File=inline=1:`);
  for (let i = 0; i < 12; i += 1) assert.equal(parser.write("A".repeat(1024 * 1024)), "");
  assert.equal(parser.write("\x07AFTER_LIMIT"), "AFTER_LIMIT");
  const huge = picture();
  huge.writeUInt32BE(4097, 16);
  assert.equal(parser.write(osc(`File=inline=1:${huge.toString("base64")}`)), "");
  assert.ok(parser.write(osc(`File=inline=1:${picture().toString("base64")}`)).startsWith(`${ESC}]1337;File=`));
});

test("IIP 重复 PNG 头在解码前拒绝", () => {
  const first = PNG.sync.write(new PNG({ width: 1, height: 1 }));
  const second = picture();
  const duplicate = Buffer.concat([first.subarray(0, 33), second.subarray(8)]);
  const parser = new Osc1337Normalizer();
  assert.equal(parser.write(osc(`File=inline=1:${duplicate.toString("base64")}`)), "");
  const gif = Buffer.from([71,73,70,56,57,97,1,0,1,0,128,0,0,255,0,0,0,0,0,
    44,0,0,0,0,255,255,255,255,0,2,2,68,1,0,59]);
  assert.equal(parser.write(osc(`File=inline=1:${gif.toString("base64")}`)), "", "GIF 帧不能绕过逻辑画布的像素上限");
});

test("取消其他控制字符串后下一条 IIP 仍被归一化", () => {
  const encoded = picture().toString("base64");
  for (const prefix of [`${ESC}]0;title\x18`, `${ESC}Pqcancel\x1a`, ESC, ESC + ESC]) {
    const parser = new Osc1337Normalizer();
    const output = [...prefix + osc(`File=inline=1:${encoded}`)].map((char) => parser.write(char)).join("");
    assert.ok(output.includes(`inline=1;size=${picture().length}:`));
  }
});

test("IIP 内联 PNG 首张立即可截图；隔离模式不宣告 SIXEL", { timeout: 30000 }, async () => {
  const responses: string[] = [];
  const image = picture();
  const sequence = osc(`File=inline=1;size=${image.length};width=16px;height=12px:${image.toString("base64")}`);
  for (const profile of ["off", "sixel", "iterm", "all"] as const) {
    const engine = await createBrowserEngine({ cols: 30, rows: 10, images: profile, onData: (data) => responses.push(data) });
    try {
      responses.length = 0;
      await engine.write(`${ESC}[?25l${ESC}[c${ESC}[2;3H`);
      for (let i = 0; i < sequence.length; i += 7) await engine.write(sequence.slice(i, i + 7));
      const capture = await engine.screenshot();
      assert.equal(redPixels(capture.png), profile === "iterm" || profile === "all" ? 192 : 0);
      if (profile === "iterm") {
        assert.equal(responses.some((text) => /^\x1b\[\?[^c]*;4(?:;|c)/.test(text)), false);
        await mkdir("artifacts/images", { recursive: true });
        await writeFile("artifacts/images/osc1337.png", capture.png);
      }
      await engine.write(`${ESC}[2J${ESC}[H`);
      assert.equal(redPixels((await engine.screenshot()).png), 0);
    } finally { await engine.close(); }
  }
});

test("IIP 分段图像支持缩放、区域截图、resize 与清屏", { timeout: 20000 }, async () => {
  const engine = await createBrowserEngine({ cols: 30, rows: 10, images: "iterm", onData() {} });
  try {
    const encoded = picture().toString("base64");
    await engine.write(`${ESC}[?25l${ESC}[2;3H` + osc("MultipartFile=inline=1;width=32px;height=24px;preserveAspectRatio=0"));
    await engine.write(osc(`FilePart=${encoded.slice(0, 19)}`, `${ESC}\\`));
    await engine.write(osc(`FilePart=${encoded.slice(19)}`) + osc("FileEnd"));
    const original = await engine.screenshot();
    assert.equal(redPixels(original.png), 32 * 24);
    const cropped = await engine.screenshot({ x: 2, y: 1, width: 4, height: 2 });
    assert.equal(redPixels(cropped.png), 32 * 24);
    await engine.resize(40, 12);
    const resized = await engine.screenshot();
    // 插件按字符像素比缩放缓存，分数列宽在 resize 后向上取整；
    // 断言精确缩放面积，避免把合法的一像素舍入误判成丢图。
    const scaledWidth = Math.ceil(32 * (resized.width / 40) / (original.width / 30));
    const scaledHeight = Math.ceil(24 * (resized.height / 12) / (original.height / 10));
    assert.equal(redPixels(resized.png), scaledWidth * scaledHeight);
    await engine.write(`${ESC}[S`);
    assert.ok(redPixels((await engine.screenshot()).png) > 0);
    await engine.write(`${ESC}[2J`);
    assert.equal(redPixels((await engine.screenshot()).png), 0);
  } finally { await engine.close(); }
});

test("IIP 百分比与字符格尺寸按实际画布计算；GIF 使用首帧", { timeout: 15000 }, async () => {
  const engine = await createBrowserEngine({ cols: 30, rows: 10, images: "iterm", onData() {} });
  try {
    await engine.write(`${ESC}[?25l`);
    const base = await engine.screenshot();
    await engine.write(osc(`File=inline=1;width=50%;height=2;preserveAspectRatio=0:${picture().toString("base64")}`));
    assert.equal(redPixels((await engine.screenshot()).png), Math.floor(base.width / 2) * Math.floor(base.height / 5));
    await engine.write(`${ESC}[2J${ESC}[H`);
    const gif = Buffer.from([71,73,70,56,57,97,1,0,1,0,128,0,0,255,0,0,0,0,0,
      44,0,0,0,0,1,0,1,0,0,2,2,68,1,0,59]);
    await engine.write(osc(`File=inline=1;width=16px;height=12px;preserveAspectRatio=0:${gif.toString("base64")}`));
    assert.equal(redPixels((await engine.screenshot()).png), 192);
  } finally { await engine.close(); }
});

test("IIP 保持比例同时约束宽高，取消控制字符串后可渲染", { timeout: 15000 }, async () => {
  const engine = await createBrowserEngine({ cols: 30, rows: 10, images: "iterm", onData() {} });
  try {
    for (const prefix of [`${ESC}]0;title\x18`, `${ESC}Pqcancel\x1a`, ESC]) {
      await engine.write(`${ESC}[2J${ESC}[H${ESC}[?25l` + prefix
        + osc(`File=inline=1;width=32px;height=12px;preserveAspectRatio=1:${picture().toString("base64")}`));
      assert.equal(redPixels((await engine.screenshot()).png), 192);
    }
  } finally { await engine.close(); }
});

test("all 模式在取消字符串后仍能处理 IIP 与 Kitty", { timeout: 15000 }, async () => {
  const replies: string[] = [];
  const engine = await createBrowserEngine({ cols: 30, rows: 10, images: "all", onData: (data) => replies.push(data) });
  try {
    await engine.write(`${ESC}[?25l${ESC}Pqcancel\x18` + osc(`File=inline=1:${picture().toString("base64")}`));
    await engine.write(`${ESC}_Ga=q,i=7,f=24,s=1,v=1;/wAA${ESC}\\`);
    assert.ok(replies.includes(`${ESC}_Gi=7;OK${ESC}\\`));
    assert.equal(redPixels((await engine.screenshot()).png), 192);
  } finally { await engine.close(); }
});

test("IIP JPEG 解码并进入截图，损坏的同尺寸 JPEG 不阻塞终端", { timeout: 20000 }, async () => {
  const executablePath = resolveBrowserExecutable();
  const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  let jpeg: string;
  try {
    const page = await browser.newPage();
    jpeg = await page.evaluate(() => {
      const canvas = document.createElement("canvas");
      canvas.width = 16; canvas.height = 12;
      const context = canvas.getContext("2d")!;
      context.fillStyle = "#ff0000"; context.fillRect(0, 0, 16, 12);
      return canvas.toDataURL("image/jpeg", 1).split(",")[1]!;
    });
  } finally { await browser.close(); }
  const engine = await createBrowserEngine({ cols: 30, rows: 10, images: "iterm", onData() {} });
  try {
    const bytes = Buffer.from(jpeg, "base64");
    // 保留 SOF 尺寸但损坏熵编码，走浏览器解码预检而非尺寸拒绝路径。
    const scan = bytes.indexOf(Buffer.from([0xff, 0xda]));
    assert.ok(scan > 0);
    await engine.write(osc(`File=inline=1:${bytes.subarray(0, scan).toString("base64")}`));
    await engine.write(`${ESC}[?25l` + osc(`File=inline=1:${jpeg}`) + `${ESC}[6;1HJPEG_READY`);
    assert.match((await engine.snapshot(1)).text, /JPEG_READY/);
    const image = PNG.sync.read((await engine.screenshot()).png);
    let red = 0;
    for (let i = 0; i < image.data.length; i += 4) {
      if (image.data[i]! >= 250 && image.data[i + 1]! <= 5 && image.data[i + 2]! <= 5) red += 1;
    }
    assert.equal(red, 192);
  } finally { await engine.close(); }
});

test("IIP 损坏数据、下载和其他扩展不阻塞后续合法图片", { timeout: 15000 }, async () => {
  const engine = await createBrowserEngine({ cols: 30, rows: 10, images: "all", onData() {} });
  try {
    await engine.write(`${ESC}[?25l` + osc("File=inline=1;size=16:R0lGODlhAQABAIAAAAAAAA=="));
    await engine.write(osc("File=inline=0;name=c2FtcGxlLnBuZw==;size=4:AAAA") + osc("Copy=not-supported"));
    await engine.write(osc(`File=inline=1;size=1:${picture().toString("base64")}`));
    await engine.write(osc(`File=inline=1;width=99999px:${picture().toString("base64")}`));
    await engine.write(osc(`File=inline=1:${picture().toString("base64")}`) + `${ESC}[6;1HAFT_INVALID`);
    assert.match((await engine.snapshot(1)).text, /AFT_INVALID/);
    assert.equal(redPixels((await engine.screenshot()).png), 192);
  } finally { await engine.close(); }
});

test("IIP 经真实 PTY、启动协议与录制回放保持图片像素", { timeout: 30000 }, async () => {
  launchOptions({ command: process.execPath, images: "iterm" });
  assert.equal(launchSchema.parse({ command: process.execPath, images: "iterm" }).images, "iterm");
  const directory = await mkdtemp(join(tmpdir(), "tuilens-iip-"));
  const manager = new SessionManager({ artifactDir: directory });
  try {
    const sequence = `${ESC}[?25l` + osc(`File=inline=1:${picture().toString("base64")}`) + `${ESC}[6;1HIIP_READY`;
    const child = `process.stdin.setRawMode(true);process.stdout.write(${JSON.stringify(sequence)});process.stdin.on('data',()=>process.exit(0));process.stdin.resume();`;
    const session = await manager.launch({ command: process.execPath, args: ["-e", child], cols: 30, rows: 10, images: "iterm", recording: {} });
    await manager.wait(session.id, { conditions: [{ kind: "text", text: "IIP_READY" }] });
    const captured = await manager.observe(session.id);
    assert.equal(redPixels(await readFile(captured.screenshot!.path)), 192);
    await manager.input(session.id, { type: "key", key: "Enter" });
    await manager.wait(session.id, { conditions: [{ kind: "exited" }] });
    const replayed = await manager.replay(session.recordingPath!);
    assert.equal(redPixels(await readFile(replayed.screenshot.path)), 192);
  } finally { await manager.closeAll(); await rm(directory, { recursive: true, force: true, maxRetries: 5 }); }
});
