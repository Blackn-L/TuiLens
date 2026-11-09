import assert from "node:assert/strict";
import test from "node:test";
import { PNG } from "pngjs";
import { compareImages } from "../src/visual/compare.js";

function png(width: number, height: number, pixels: number[][]): Buffer {
  const image = new PNG({ width, height });
  for (let index = 0; index < width * height; index += 1) {
    image.data.set(pixels[index] ?? [0, 0, 0, 255], index * 4);
  }
  return PNG.sync.write(image);
}

test("像素回归返回精确差异数量、比例和可检查的差异图", () => {
  const baseline = png(2, 2, [[10, 20, 30, 255], [255, 255, 255, 255]]);
  const actual = png(2, 2, [[10, 20, 31, 255], [255, 255, 255, 255]]);
  const result = compareImages(actual, baseline);
  assert.equal(result.pass, false);
  assert.equal(result.differentPixels, 1);
  assert.equal(result.totalPixels, 4);
  assert.equal(result.diffRatio, 0.25);
  assert.equal(result.width, 2);
  assert.equal(result.height, 2);
  const diff = PNG.sync.read(result.diffPng);
  assert.deepEqual([...diff.data.subarray(0, 4)], [255, 32, 64, 255]);
  assert.equal(diff.data[4], diff.data[5]);
  assert.equal(compareImages(actual, baseline, { pixelThreshold: 1 }).pass, true);
  assert.equal(compareImages(actual, baseline, { maxDiffRatio: 0.25 }).pass, true);
  assert.equal(compareImages(actual, baseline, { maxDiffRatio: 0.249 }).pass, false);
});

test("遮罩只排除指定像素，重复遮罩不重复扣减分母", () => {
  const baseline = png(3, 2, []);
  const actual = png(3, 2, [
    [255, 0, 0, 255], [255, 0, 0, 255], [255, 0, 0, 255],
  ]);
  const masks = [{ x: 0, y: 0, width: 2, height: 1 }, { x: 0, y: 0, width: 1, height: 1 }];
  const result = compareImages(actual, baseline, { masks });
  assert.equal(result.totalPixels, 4);
  assert.equal(result.differentPixels, 1);
  assert.equal(result.diffRatio, 0.25);
  const diff = PNG.sync.read(result.diffPng);
  assert.deepEqual([...diff.data.subarray(0, 4)], [66, 133, 190, 255]);
  assert.deepEqual([...diff.data.subarray(8, 12)], [255, 32, 64, 255]);
  assert.equal(compareImages(actual, baseline, {
    masks: [{ x: 0, y: 0, width: 3, height: 1 }],
  }).pass, true);
  assert.throws(() => compareImages(actual, baseline, {
    masks: [{ x: 0, y: 0, width: 3, height: 2 }],
  }), { code: "EMPTY_COMPARISON" });
});

test("透明像素隐藏 RGB 不影响结果，但可见透明度变化会被捕获", () => {
  const transparentRed = png(1, 1, [[255, 0, 0, 0]]);
  const transparentBlue = png(1, 1, [[0, 0, 255, 0]]);
  assert.equal(compareImages(transparentRed, transparentBlue).pass, true);
  const opaqueWhite = png(1, 1, [[255, 255, 255, 255]]);
  assert.equal(compareImages(transparentRed, opaqueWhite).pass, false);
  const halfRed = png(1, 1, [[255, 0, 0, 128]]);
  assert.equal(compareImages(halfRed, transparentRed).pass, false);
});

test("无效阈值、遮罩与图片尺寸明确失败", () => {
  const image = png(2, 2, []);
  assert.throws(() => compareImages(image, png(1, 1, [])), { code: "IMAGE_DIMENSIONS_MISMATCH" });
  for (const pixelThreshold of [-1, 256, 0.5, NaN]) {
    assert.throws(() => compareImages(image, image, { pixelThreshold }), { code: "INVALID_ARGUMENT" });
  }
  for (const maxDiffRatio of [-1, 1.1, NaN, Infinity]) {
    assert.throws(() => compareImages(image, image, { maxDiffRatio }), { code: "INVALID_ARGUMENT" });
  }
  for (const region of [
    { x: -1, y: 0, width: 1, height: 1 },
    { x: 0, y: 0, width: 0, height: 1 },
    { x: 0, y: 0, width: 3, height: 1 },
    { x: 0, y: 2, width: 1, height: 1 },
    { x: 0.5, y: 0, width: 1, height: 1 },
  ]) {
    assert.throws(() => compareImages(image, image, { masks: [region] }), { code: "INVALID_ARGUMENT" });
  }
});

test("解码前拒绝超限尺寸、动画、交错、截断与 CRC 错误", () => {
  const image = png(2, 2, []);
  const oversized = Buffer.from(image);
  oversized.writeUInt32BE(8193, 16);
  assert.throws(() => compareImages(oversized, oversized), { code: "IMAGE_LIMIT" });
  const area = Buffer.from(image);
  area.writeUInt32BE(8192, 16);
  area.writeUInt32BE(8192, 20);
  assert.throws(() => compareImages(area, area), { code: "IMAGE_LIMIT" });
  const interlaced = Buffer.from(image);
  interlaced[28] = 1;
  assert.throws(() => compareImages(interlaced, interlaced), { code: "UNSUPPORTED_PNG" });
  const animationChunk = Buffer.alloc(20);
  animationChunk.writeUInt32BE(8, 0);
  animationChunk.write("acTL", 4, "ascii");
  const animated = Buffer.concat([image.subarray(0, 33), animationChunk, image.subarray(33)]);
  assert.throws(() => compareImages(animated, animated), { code: "UNSUPPORTED_PNG" });
  for (const invalid of [Buffer.from("not a png"), image.subarray(0, 35), Buffer.concat([image, Buffer.from("trailing")])]) {
    assert.throws(() => compareImages(invalid, invalid), { code: "INVALID_PNG" });
  }
  const crc = Buffer.from(image);
  crc[29] = (crc[29] ?? 0) ^ 1;
  assert.throws(() => compareImages(crc, crc), { code: "INVALID_PNG" });
});
