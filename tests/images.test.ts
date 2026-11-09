import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { test } from "node:test";
import { PNG } from "pngjs";
import { createBrowserEngine } from "../src/engine/browser-engine.js";

const ESC = "\x1b";
const apc = (data: string) => `${ESC}_G${data}${ESC}\\`;
const redSixel = `${ESC}Pq"1;1;16;12#1;2;100;0;0#1!16~-!16~${ESC}\\`;
function bitmap(r: number, g: number, b: number, height = 16): string {
  const png = new PNG({ width: 16, height });
  for (let i = 0; i < png.data.length; i += 4) png.data.set([r, g, b, 255], i);
  return PNG.sync.write(png).toString("base64");
}
function count(png: Buffer, color: [number, number, number]): number {
  const decoded = PNG.sync.read(png);
  let pixels = 0;
  for (let i = 0; i < decoded.data.length; i += 4) {
    if (decoded.data[i] === color[0] && decoded.data[i + 1] === color[1] && decoded.data[i + 2] === color[2]) pixels += 1;
  }
  return pixels;
}
function chunk(type: string, bytes: Buffer): Buffer {
  const result = Buffer.alloc(bytes.length + 12);
  result.writeUInt32BE(bytes.length, 0);
  result.write(type, 4, "ascii");
  bytes.copy(result, 8);
  let crc = 0xffffffff;
  for (const byte of result.subarray(4, -4)) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, result.length - 4);
  return result;
}

test("SIXEL 只在启用时声明能力，首图与擦除均进入截图", { timeout: 30000 }, async () => {
  const responses: string[] = [];
  const off = await createBrowserEngine({ cols: 20, rows: 8, onData: (data) => responses.push(data) });
  try {
    await off.write(`${ESC}[c${ESC}[?25l` + redSixel);
    assert.equal(responses.some((data) => data.startsWith(`${ESC}[?`) && data.split(";").includes("4")), false);
    assert.equal(count((await off.screenshot()).png, [255, 0, 0]), 0);
  } finally { await off.close(); }
  const engine = await createBrowserEngine({ cols: 20, rows: 8, images: "sixel", onData: (data) => responses.push(data) });
  try {
    await engine.write(`${ESC}[c${ESC}[?25l${ESC}[2;3H` + redSixel);
    assert.ok(responses.some((data) => /^\x1b\[\?[^c]*;4(?:;|c)/.test(data)), "启用 SIXEL 后应声明 DA1 属性 4");
    const image = await engine.screenshot();
    assert.equal(count(image.png, [255, 0, 0]), 192);
    await mkdir("artifacts/images", { recursive: true });
    await writeFile("artifacts/images/sixel.png", image.png);
    await engine.write(`${ESC}[2J${ESC}[H`);
    assert.equal(count((await engine.screenshot()).png, [255, 0, 0]), 0);
  } finally { await engine.close(); }
});

test("Kitty PNG 内联分块传输、替换和删除不依赖额外观察轮次", { timeout: 30000 }, async () => {
  const responses: string[] = [];
  const engine = await createBrowserEngine({ cols: 20, rows: 8, images: "all", onData: (data) => responses.push(data) });
  try {
    await engine.write(`${ESC}[?25l${ESC}[2;3H`);
    const red = bitmap(255, 0, 0);
    await engine.write(apc(`a=T,f=100,i=7,C=1,c=2,r=2,m=1;${red.slice(0, 40)}`));
    await engine.write(apc(`m=0;${red.slice(40)}`));
    assert.ok(responses.includes(apc("i=7;OK")));
    assert.ok(count((await engine.screenshot()).png, [255, 0, 0]) > 150);
    await engine.write(apc(`a=t,f=100,i=7;${bitmap(0, 255, 0)}`));
    const replacement = await engine.screenshot();
    assert.equal(count(replacement.png, [255, 0, 0]), 0);
    assert.ok(count(replacement.png, [0, 255, 0]) > 150);
    await engine.write(apc("a=d,d=I,i=7"));
    assert.equal(count((await engine.screenshot()).png, [0, 255, 0]), 0);
    await engine.write(apc("a=q,i=8,f=24,s=1,v=1;/wAA"));
    assert.ok(responses.includes(apc("i=8;OK")));
    await engine.write(apc("a=q,i=9,f=32,s=4096,v=4096;AAAA"));
    assert.ok(responses.some((response) => response.includes("i=9;E2BIG")));
  } finally { await engine.close(); }
});

test("Kitty 虚拟占位符跟随正文覆盖、滚动、resize 和清屏", { timeout: 30000 }, async () => {
  const engine = await createBrowserEngine({ cols: 20, rows: 8, images: "all", onData() {} });
  try {
    await engine.write(`${ESC}[?25l`);
    const sequence = apc(`a=T,f=100,i=42,U=1,c=2,r=2,q=2;${bitmap(255, 0, 0, 32)}`);
    // APC 的前缀、载荷和结束符都可能跨 PTY 数据块。
    await engine.write(sequence.slice(0, 1));
    await engine.write(sequence.slice(1, -1));
    await engine.write(sequence.slice(-1));
    const p = String.fromCodePoint(0x10eeee);
    await engine.write(`${ESC}[2;3H${ESC}[38;5;42m${p}\u0305\u0305${p}\u0305\u030d${ESC}[3;3H${p}\u030d\u0305${p}\u030d\u030d${ESC}[0m`);
    const first = await engine.screenshot();
    const firstPixels = count(first.png, [255, 0, 0]);
    assert.ok(firstPixels > 500, "占位符应绘制两个字符行的真实图像像素");
    assert.equal(count(first.png, [0, 215, 135]), 0, "占位符不能残留前景色缺字框");
    await mkdir("artifacts/images", { recursive: true });
    await writeFile("artifacts/images/kitty-virtual.png", first.png);
    await engine.write(`${ESC}[2;3HX`);
    assert.ok(count((await engine.screenshot()).png, [255, 0, 0]) < firstPixels, "正文覆盖占位符必须遮挡图块");
    await engine.resize(30, 10);
    assert.ok(count((await engine.screenshot()).png, [255, 0, 0]) > 0);
    await engine.write(`${ESC}[S`);
    assert.ok(count((await engine.screenshot()).png, [255, 0, 0]) > 0);
    await engine.write(`${ESC}[2J`);
    assert.equal(count((await engine.screenshot()).png, [255, 0, 0]), 0);
  } finally { await engine.close(); }
});

test("Kitty 图像数量有上限，拒绝外部介质和不支持的放置", { timeout: 30000 }, async () => {
  const responses: string[] = [];
  const engine = await createBrowserEngine({ cols: 8, rows: 4, images: "all", onData: (data) => responses.push(data) });
  try {
    await engine.write(Array.from({ length: 129 }, (_, index) =>
      apc(`a=t,f=24,s=1,v=1,i=${index + 1},q=2;/wAA`)).join(""));
    await engine.write(apc("a=p,i=1,C=1"));
    assert.ok(responses.some((data) => data.includes("i=1;ENOENT")), "最旧图像应已逐出缓存");
    await engine.write(apc("a=q,i=999,t=f,f=100;L2ZpbGU="));
    assert.ok(responses.some((data) => data.includes("i=999;ENOTSUP:transmission medium")));
    await engine.write(apc("a=p,i=129,U=1,c=1,r=1,p=3"));
    assert.ok(responses.some((data) => data.includes("p=3;ENOTSUP:virtual placement id")));
    await engine.write(apc("a=d,d=A"));
    await engine.write(apc("a=p,i=129,C=1"));
    assert.ok(responses.some((data) => data.includes("i=129;ENOENT")));
  } finally { await engine.close(); }
});

test("Kitty 放置面积预算包含视口外格子，删除释放预算", { timeout: 30000 }, async () => {
  const responses: string[] = [];
  const engine = await createBrowserEngine({ cols: 20, rows: 8, images: "all", onData: (data) => responses.push(data) });
  try {
    await engine.write(apc("a=t,f=24,s=1,v=1,i=41,q=2;/wAA"));
    await engine.write(apc("a=p,i=41,p=1,c=500,r=250,C=1"));
    assert.ok(responses.at(-1)?.includes("ENOSPC:placement cell limit"));
    await engine.write(apc("a=p,i=41,p=1,c=256,r=128,C=1"));
    assert.equal(responses.at(-1), apc("i=41,p=1;OK"));
    await engine.write(apc("a=p,i=41,p=2,c=256,r=128,C=1"));
    assert.equal(responses.at(-1), apc("i=41,p=2;OK"));
    await engine.write(apc("a=p,i=41,p=3,c=1,r=1,C=1"));
    assert.ok(responses.at(-1)?.includes("ENOSPC:placement cell limit"));
    await engine.write(apc("a=d,d=i,i=41,p=1"));
    await engine.write(apc("a=p,i=41,p=3,c=1,r=1,C=1"));
    assert.equal(responses.at(-1), apc("i=41,p=3;OK"));
  } finally { await engine.close(); }
});

test("Kitty 普通放置的行擦除只移除水平交集", { timeout: 30000 }, async () => {
  const engine = await createBrowserEngine({ cols: 20, rows: 8, images: "all", onData() {} });
  try {
    await engine.write(`${ESC}[?25l${ESC}[2;3H` + apc(`a=T,f=100,i=18,c=2,r=2,C=1,q=2;${bitmap(255, 0, 0, 32)}`));
    const before = count((await engine.screenshot()).png, [255, 0, 0]);
    await engine.write(`${ESC}[2;18H${ESC}[K`);
    assert.equal(count((await engine.screenshot()).png, [255, 0, 0]), before, "右侧尾部擦除不得影响左侧图片");
    await engine.write(`${ESC}[2;2H${ESC}[1K`);
    assert.equal(count((await engine.screenshot()).png, [255, 0, 0]), before, "左侧擦除不得影响右侧图片");
    await engine.write(`${ESC}[2;4H${ESC}[K`);
    const partial = count((await engine.screenshot()).png, [255, 0, 0]);
    assert.ok(partial < before && partial > before / 2, "只擦除图像首行的右半格");
    await engine.write(`${ESC}[3;1H${ESC}[2K`);
    const bottomErased = count((await engine.screenshot()).png, [255, 0, 0]);
    assert.ok(bottomErased > 0 && bottomErased < partial, "整行擦除不影响图像的另一行");
  } finally { await engine.close(); }
});

test("Kitty PNG 容器检查拒绝动画、坏 CRC 与尾随数据", { timeout: 30000 }, async () => {
  const responses: string[] = [];
  const engine = await createBrowserEngine({ cols: 8, rows: 4, images: "all", onData: (data) => responses.push(data) });
  try {
    const raw = Buffer.from(bitmap(255, 0, 0), "base64");
    const animationControl = Buffer.alloc(8);
    animationControl.writeUInt32BE(1);
    const animated = Buffer.concat([raw.subarray(0, 33), chunk("acTL", animationControl), raw.subarray(33)]);
    await engine.write(apc(`a=q,i=21,f=100;${animated.toString("base64")}`));
    assert.ok(responses.at(-1)?.includes("ENOTSUP:animated PNG"));
    const corrupt = Buffer.from(raw);
    corrupt[29] = corrupt[29]! ^ 1;
    await engine.write(apc(`a=q,i=22,f=100;${corrupt.toString("base64")}`));
    assert.ok(responses.at(-1)?.includes("EINVAL:PNG CRC"));
    await engine.write(apc(`a=q,i=23,f=100;${Buffer.concat([raw, Buffer.from("trailing")]).toString("base64")}`));
    assert.ok(responses.at(-1)?.includes("EINVAL:PNG end"));
  } finally { await engine.close(); }
});

test("字符格截图区域按真实像素裁剪并拒绝越界", { timeout: 30000 }, async () => {
  const engine = await createBrowserEngine({ cols: 20, rows: 8, onData() {} });
  try {
    await engine.write(`${ESC}[?25l${ESC}[48;2;0;255;0m${ESC}[2J`);
    const full = await engine.screenshot();
    const crop = await engine.screenshot({ x: 0, y: 0, width: 5, height: 2 });
    assert.ok(Math.abs(crop.width - full.width / 4) < 2);
    assert.ok(Math.abs(crop.height - full.height / 4) < 2);
    assert.equal(count(crop.png, [0, 255, 0]), crop.width * crop.height);
    await assert.rejects(engine.screenshot({ x: 19, y: 0, width: 2, height: 1 }), { code: "INVALID_REGION" });
  } finally { await engine.close(); }
});
