import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Region } from "../core/types.js";
import { compareImages } from "./compare.js";
import { readBoundedFile } from "../core/bounded-file.js";

export interface VisualOptions {
  baseline: string;
  region?: Region;
  pixelThreshold?: number;
  maxDiffRatio?: number;
  masks?: Region[];
}

/** 基准只读；接受新基准需要调用者显式复制，比较绝不覆盖输入文件。 */
export async function compareArtifact(actual: string, options: VisualOptions, directory: string) {
  const compared = compareImages(await readBoundedFile(actual, 32 * 1024 * 1024),
    await readBoundedFile(options.baseline, 32 * 1024 * 1024), {
    ...(options.pixelThreshold === undefined ? {} : { pixelThreshold: options.pixelThreshold }),
    ...(options.maxDiffRatio === undefined ? {} : { maxDiffRatio: options.maxDiffRatio }),
    ...(options.masks ? { masks: options.masks } : {}),
  });
  const { diffPng, ...counts } = compared;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const diff = join(directory, `diff-${randomUUID()}.png`);
  await writeFile(diff, diffPng, { mode: 0o600 });
  const result = { ...counts, actual, baseline: options.baseline, diff };
  await writeFile(diff.replace(/\.png$/, ".json"), JSON.stringify(result, null, 2), { mode: 0o600 });
  return result;
}
