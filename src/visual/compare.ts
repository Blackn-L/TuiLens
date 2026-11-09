import { PNG } from "pngjs";
import { TuiLensError } from "../core/errors.js";
import type { Region } from "../core/types.js";

export interface CompareOptions {
  /** 每通道最大允许差值，范围 0～255；默认要求像素完全相同。 */
  pixelThreshold?: number;
  /** 不同像素占未遮罩像素的允许比例，范围 0～1。 */
  maxDiffRatio?: number;
  /** 相对于比较图片左上角的像素区域，不是终端字符格。 */
  masks?: Region[];
}

export interface CompareResult {
  pass: boolean;
  differentPixels: number;
  /** 分母只包含未遮罩的像素。 */
  totalPixels: number;
  diffRatio: number;
  width: number;
  height: number;
  diffPng: Buffer;
}

const MAX_PNG_BYTES = 32 * 1024 * 1024;
const MAX_PIXELS = 16 * 1024 * 1024;
const MAX_DIMENSION = 8192;
const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function invalid(message: string): never {
  throw new TuiLensError("INVALID_PNG", message);
}

/**
 * 解码前检查压缩大小、尺寸和容器结构。仅接收截图使用的非交错 8 位 PNG，
 * 避免解码器的交错分支在校验输出尺寸前执行无界 inflate。
 */
function inspectPng(buffer: Buffer): { width: number; height: number } {
  if (!Buffer.isBuffer(buffer) || buffer.length > MAX_PNG_BYTES) {
    throw new TuiLensError("IMAGE_LIMIT", "PNG 大小不能超过 32 MiB");
  }
  if (buffer.length < 45 || !buffer.subarray(0, 8).equals(SIGNATURE)) {
    invalid("输入不是完整 PNG");
  }
  if (buffer.readUInt32BE(8) !== 13 || buffer.toString("ascii", 12, 16) !== "IHDR") {
    invalid("PNG 必须以标准 IHDR 开始");
  }
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (!width || !height || width > MAX_DIMENSION || height > MAX_DIMENSION ||
      width * height > MAX_PIXELS) {
    throw new TuiLensError("IMAGE_LIMIT", "PNG 边长不能超过 8192，像素数不能超过 16777216");
  }
  if (buffer[24] !== 8 || buffer[26] !== 0 || buffer[27] !== 0 || buffer[28] !== 0) {
    throw new TuiLensError("UNSUPPORTED_PNG", "视觉比较仅接受非交错的 8 位 PNG");
  }
  if (![0, 2, 3, 4, 6].includes(buffer[25]!)) invalid("PNG 色彩类型无效");
  let offset = 8;
  let chunks = 0;
  let hasData = false;
  while (offset < buffer.length) {
    if (buffer.length - offset < 12) invalid("PNG 数据块不完整");
    const size = buffer.readUInt32BE(offset);
    if (size > buffer.length - offset - 12) invalid("PNG 数据块越界");
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    if (++chunks > 65536) throw new TuiLensError("IMAGE_LIMIT", "PNG 数据块数量超过限制");
    if (type === "IHDR" && offset !== 8) invalid("PNG 包含重复 IHDR");
    if (type === "acTL") throw new TuiLensError("UNSUPPORTED_PNG", "视觉比较不接受动画 PNG");
    if (type === "IDAT") hasData = true;
    offset += size + 12;
    if (type === "IEND") {
      if (size !== 0 || !hasData || offset !== buffer.length) invalid("PNG 结束块无效或存在尾随数据");
      return { width, height };
    }
  }
  return invalid("PNG 缺少 IEND");
}

function decodePng(buffer: Buffer) {
  const size = inspectPng(buffer);
  try {
    const image = PNG.sync.read(buffer, { checkCRC: true });
    if (image.width !== size.width || image.height !== size.height ||
        image.data.length !== size.width * size.height * 4) {
      invalid("PNG 解码尺寸不一致");
    }
    return image;
  } catch (error) {
    if (error instanceof TuiLensError) throw error;
    throw new TuiLensError("INVALID_PNG", "PNG 解码失败", {
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

function validateOptions(options: CompareOptions): { threshold: number; ratio: number; masks: Region[] } {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new TuiLensError("INVALID_ARGUMENT", "视觉比较选项必须是对象");
  }
  const threshold = options.pixelThreshold ?? 0;
  const ratio = options.maxDiffRatio ?? 0;
  if (!Number.isInteger(threshold) || threshold < 0 || threshold > 255 ||
      !Number.isFinite(ratio) || ratio < 0 || ratio > 1) {
    throw new TuiLensError("INVALID_ARGUMENT", "像素阈值为 0～255 整数，差异比例为 0～1");
  }
  const masks = options.masks ?? [];
  if (!Array.isArray(masks) || masks.length > 256) {
    throw new TuiLensError("INVALID_ARGUMENT", "最多允许 256 个像素遮罩");
  }
  return { threshold, ratio, masks };
}

function buildMask(masks: Region[], width: number, height: number): Uint8Array {
  const result = new Uint8Array(width * height);
  let work = 0;
  for (const region of masks) {
    if (!region || ![region.x, region.y, region.width, region.height].every(Number.isInteger) ||
        region.x < 0 || region.y < 0 || region.width < 1 || region.height < 1 ||
        region.x + region.width > width || region.y + region.height > height) {
      throw new TuiLensError("INVALID_ARGUMENT", "像素遮罩必须完整位于比较图片内");
    }
    work += region.width * region.height;
    if (work > MAX_PIXELS * 8) throw new TuiLensError("IMAGE_LIMIT", "重叠遮罩的累计面积超过限制");
    for (let y = region.y; y < region.y + region.height; y += 1) {
      result.fill(1, y * width + region.x, y * width + region.x + region.width);
    }
  }
  return result;
}

function composite(channel: number, alpha: number, matte: number): number {
  return Math.round((channel * alpha + matte * (255 - alpha)) / 255);
}

/**
 * 在黑、白两种底色上比较合成颜色：忽略全透明像素的隐藏 RGB，
 * 同时捕获会在不同终端底色上显现的透明度变化。
 */
function pixelDistance(left: Buffer, right: Buffer, offset: number): number {
  let distance = 0;
  for (let channel = 0; channel < 3; channel += 1) {
    for (const matte of [0, 255]) {
      distance = Math.max(distance, Math.abs(
        composite(left[offset + channel]!, left[offset + 3]!, matte)
        - composite(right[offset + channel]!, right[offset + 3]!, matte),
      ));
    }
  }
  return distance;
}

/** 纯比较函数：不读取路径，不创建或覆盖基准图片。 */
export function compareImages(actual: Buffer, baseline: Buffer, options: CompareOptions = {}): CompareResult {
  const { threshold, ratio, masks } = validateOptions(options);
  const actualSize = inspectPng(actual);
  const baselineSize = inspectPng(baseline);
  if (actualSize.width !== baselineSize.width || actualSize.height !== baselineSize.height) {
    throw new TuiLensError("IMAGE_DIMENSIONS_MISMATCH", "实际图片与基准图片尺寸不一致", {
      actual: actualSize, baseline: baselineSize,
    });
  }
  const { width, height } = actualSize;
  const mask = buildMask(masks, width, height);
  const totalPixels = mask.reduce((total, value) => total + (value === 0 ? 1 : 0), 0);
  if (!totalPixels) throw new TuiLensError("EMPTY_COMPARISON", "遮罩不能覆盖全部像素");
  const current = decodePng(actual);
  const reference = decodePng(baseline);
  const diff = new PNG({ width, height });
  let differentPixels = 0;
  for (let index = 0; index < width * height; index += 1) {
    const offset = index * 4;
    diff.data[offset + 3] = 255;
    if (mask[index]) {
      // 蓝色表示排除的区域，避免误把没有检查的像素当成匹配。
      diff.data[offset] = 66;
      diff.data[offset + 1] = 133;
      diff.data[offset + 2] = 190;
    } else if (pixelDistance(current.data, reference.data, offset) > threshold) {
      differentPixels += 1;
      diff.data[offset] = 255;
      diff.data[offset + 1] = 32;
      diff.data[offset + 2] = 64;
    } else {
      const gray = Math.round((composite(current.data[offset]!, current.data[offset + 3]!, 255)
        + composite(current.data[offset + 1]!, current.data[offset + 3]!, 255)
        + composite(current.data[offset + 2]!, current.data[offset + 3]!, 255)) / 3);
      const dimmed = Math.round(128 + gray / 2);
      diff.data[offset] = dimmed;
      diff.data[offset + 1] = dimmed;
      diff.data[offset + 2] = dimmed;
    }
  }
  const diffRatio = differentPixels / totalPixels;
  return {
    pass: diffRatio <= ratio, differentPixels, totalPixels, diffRatio, width, height,
    diffPng: PNG.sync.write(diff),
  };
}
