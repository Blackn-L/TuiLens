import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { z } from "zod";
import { readBoundedFile } from "../core/bounded-file.js";
import { TuiLensError } from "../core/errors.js";
import type {
  ImageProfile, ResolvedTerminalProfile, TerminalCapabilities, TerminalGraphicsCapabilities,
  TerminalProfileSource, TerminalReplies,
} from "../core/types.js";
import { findTerminalPreset, listTerminalProfiles } from "./registry.js";
import type { TerminalPresetDefinition } from "./presets/types.js";

const MAX_PROFILE_BYTES = 256 * 1024;
const MAX_EXTENDS_DEPTH = 16;

const profileReference = z.string().trim().min(1).max(8192);
const profileName = z.string().trim().min(1).max(160);
const environmentKey = z.string().min(1).max(256)
  .refine((value) => !value.includes("=") && !value.includes("\0"), "环境变量名不能包含 = 或 NUL");
const environmentValue = z.string().max(32 * 1024)
  .refine((value) => !value.includes("\0"), "环境变量值不能包含 NUL");
const terminalReply = z.string().max(4096)
  .refine((value) => !value.includes("\0") && !/[\r\n]/u.test(value)
    && (value === "" || value.startsWith("\x1b")), "终端应答必须是空串或单个 ESC 序列");

export const profileFileSchema = z.object({
  name: profileName.optional(),
  extends: profileReference.optional(),
  versionRange: z.string().trim().min(1).max(160).optional(),
  env: z.record(environmentKey, environmentValue).optional(),
  replies: z.object({
    da1: terminalReply.optional(),
    da2: terminalReply.optional(),
    xtversion: terminalReply.optional(),
  }).strict().optional(),
  capabilities: z.object({
    color: z.enum(["none", "ansi16", "ansi256", "truecolor"]).optional(),
    keyboard: z.object({
      kitty: z.number().int().min(0).max(0x7fffffff).optional(),
      modifyOtherKeys: z.number().int().min(0).max(2).optional(),
    }).strict().optional(),
    mouse: z.array(z.string().regex(/^\d{3,4}$/u)).max(64).optional(),
    graphics: z.object({
      sixel: z.boolean().optional(),
      kitty: z.boolean().optional(),
      iterm: z.boolean().optional(),
    }).strict().optional(),
    underlineStyles: z.array(z.enum(["single", "double", "curly", "dotted", "dashed"])).max(16).optional(),
    synchronizedOutput: z.boolean().optional(),
    focusEvents: z.boolean().optional(),
    hyperlink: z.boolean().optional(),
    unicodeVersion: z.string().trim().min(1).max(32).optional(),
    scrollback: z.number().int().min(0).max(5000).optional(),
  }).strict().optional(),
}).strict();

interface ProfileFile {
  name?: string;
  extends?: string;
  versionRange?: string;
  env?: Record<string, string>;
  replies?: TerminalReplies;
  capabilities?: TerminalCapabilities;
}

export interface ResolveTerminalProfileOptions {
  cwd?: string;
}

export interface TerminalProfileOverrides {
  images?: ImageProfile;
  graphics?: TerminalGraphicsCapabilities;
  colorMode?: "truecolor" | "ansi256" | "none";
  scrollback?: number;
}

function cloneCapabilities(value: TerminalCapabilities): TerminalCapabilities {
  return {
    ...value,
    ...(value.keyboard ? { keyboard: { ...value.keyboard } } : {}),
    ...(value.graphics ? { graphics: { ...value.graphics } } : {}),
    ...(value.mouse ? { mouse: [...value.mouse] } : {}),
    ...(value.underlineStyles ? { underlineStyles: [...value.underlineStyles] } : {}),
  };
}

function mergeCapabilities(
  base: TerminalCapabilities | undefined,
  overlay: TerminalCapabilities | undefined,
): TerminalCapabilities {
  if (!base && !overlay) return {};
  const merged = cloneCapabilities(base ?? {});
  if (!overlay) return merged;
  for (const key of ["color", "synchronizedOutput", "focusEvents", "hyperlink", "unicodeVersion", "scrollback"] as const) {
    if (overlay[key] !== undefined) {
      Object.assign(merged, { [key]: overlay[key] });
    }
  }
  if (overlay.keyboard) merged.keyboard = { ...merged.keyboard, ...overlay.keyboard };
  if (overlay.graphics) merged.graphics = { ...merged.graphics, ...overlay.graphics };
  if (overlay.mouse) merged.mouse = [...overlay.mouse];
  if (overlay.underlineStyles) merged.underlineStyles = [...overlay.underlineStyles];
  return merged;
}

function synthesizeDa1(capabilities: TerminalCapabilities): string {
  const features = ["62"];
  if (capabilities.graphics?.sixel === true) features.push("4");
  if ((capabilities.color ?? "none") !== "none") features.push("22");
  return `\x1b[?${features.join(";")}c`;
}

/** DA1 的 feature 4 是 SIXEL；显式应答也必须与声明的 graphics 一致。 */
function alignDa1Sixel(reply: string, enabled: boolean): string {
  const match = /^\x1b\[\?(\d+(?:;\d+)*)c$/u.exec(reply);
  if (!match) return reply;
  const features = match[1]!.split(";").map(Number).filter((value) => value !== 4);
  if (enabled) {
    const insertAt = features[0] === 62 ? 1 : features.length;
    features.splice(insertAt, 0, 4);
  }
  return `\x1b[?${features.join(";")}c`;
}

function completeReplies(replies: TerminalReplies, capabilities: TerminalCapabilities): TerminalReplies {
  const da1 = replies.da1 === undefined
    ? synthesizeDa1(capabilities)
    : alignDa1Sixel(replies.da1, capabilities.graphics?.sixel === true);
  return {
    ...replies,
    da1,
  };
}

function fromPreset(preset: TerminalPresetDefinition, reference: string): ResolvedTerminalProfile {
  const capabilities = cloneCapabilities(preset.capabilities);
  return {
    name: preset.name,
    versionRange: preset.versionRange,
    env: { ...preset.env },
    replies: completeReplies({ ...preset.replies }, capabilities),
    capabilities,
    source: { kind: "preset", reference },
  };
}

function mergeProfileFile(
  base: ResolvedTerminalProfile | undefined,
  file: ProfileFile,
  source: TerminalProfileSource,
): ResolvedTerminalProfile {
  const name = file.name ?? base?.name;
  if (!name) throw new TuiLensError("INVALID_PROFILE", "profile 必须声明 name，或通过 extends 继承名称");
  const versionRange = file.versionRange ?? base?.versionRange;
  const capabilities = mergeCapabilities(base?.capabilities, file.capabilities);
  return {
    name,
    ...(versionRange === undefined ? {} : { versionRange }),
    env: { ...base?.env, ...file.env },
    replies: completeReplies({ ...base?.replies, ...file.replies }, capabilities),
    capabilities,
    source,
  };
}

interface ResolveContext {
  visited: Set<string>;
  depth: number;
}

function profileFileError(error: unknown): never {
  if (error instanceof TuiLensError && error.code === "FILE_LIMIT") {
    throw new TuiLensError("INVALID_PROFILE", "terminal profile 文件超过 256 KiB", error.details);
  }
  throw new TuiLensError("PROFILE_NOT_FOUND", "找不到或无法读取 terminal profile 文件", {
    reason: error instanceof Error ? error.message : String(error),
    ...(error instanceof TuiLensError && error.details !== undefined ? { details: error.details } : {}),
  });
}

async function canonicalPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    profileFileError(error);
  }
}

async function resolveFromFile(path: string, reference: string, context: ResolveContext): Promise<ResolvedTerminalProfile> {
  if (context.depth >= MAX_EXTENDS_DEPTH) {
    throw new TuiLensError("PROFILE_DEPTH", `terminal profile 继承层级不能超过 ${MAX_EXTENDS_DEPTH} 层`);
  }
  const canonical = await canonicalPath(path);
  if (context.visited.has(canonical)) {
    throw new TuiLensError("PROFILE_CYCLE", "terminal profile 的 extends 形成循环", { path: canonical });
  }
  context.visited.add(canonical);
  let text: string;
  try {
    text = (await readBoundedFile(canonical, MAX_PROFILE_BYTES)).toString("utf8");
  } catch (error) {
    profileFileError(error);
  }
  let definition: ProfileFile;
  try {
    definition = profileFileSchema.parse(JSON.parse(text)) as ProfileFile;
  } catch (error) {
    throw new TuiLensError("INVALID_PROFILE", "terminal profile 不是有效的 profile JSON", {
      path: canonical,
      reason: error instanceof Error ? error.message : String(error),
      ...(error instanceof z.ZodError ? { issues: error.issues } : {}),
    });
  }
  let base: ResolvedTerminalProfile | undefined;
  if (definition.extends) {
    base = await resolveReference(definition.extends, dirname(canonical), {
      ...context,
      depth: context.depth + 1,
    });
  }
  return mergeProfileFile(base, definition, {
    kind: "file",
    reference,
    path: canonical,
  });
}

async function resolveReference(
  reference: string,
  baseDirectory: string,
  context: ResolveContext,
): Promise<ResolvedTerminalProfile> {
  const preset = findTerminalPreset(reference);
  if (preset) return fromPreset(preset, reference);
  const path = isAbsolute(reference) ? reference : resolve(baseDirectory, reference);
  return resolveFromFile(path, reference, context);
}

export async function resolveTerminalProfile(
  reference = "xterm-256color",
  options: ResolveTerminalProfileOptions = {},
): Promise<ResolvedTerminalProfile> {
  const parsed = profileReference.safeParse(reference);
  if (!parsed.success) {
    throw new TuiLensError("INVALID_PROFILE", "terminal profile 必须是非空 preset 名称或文件路径", {
      issues: parsed.error.issues,
    });
  }
  const cwd = resolve(options.cwd ?? process.cwd());
  return resolveReference(parsed.data, cwd, {
    visited: new Set(),
    depth: 0,
  });
}

export function imageProfileGraphics(images: ImageProfile): TerminalGraphicsCapabilities {
  switch (images) {
    case "off": return { sixel: false, kitty: false, iterm: false };
    case "sixel": return { sixel: true, kitty: false, iterm: false };
    case "iterm": return { sixel: false, kitty: false, iterm: true };
    case "all": return { sixel: true, kitty: true, iterm: true };
  }
}

function applyCapabilityOverrides(
  capabilities: TerminalCapabilities,
  overrides: TerminalProfileOverrides,
): TerminalCapabilities {
  const result = cloneCapabilities(capabilities);
  if (overrides.colorMode !== undefined) {
    result.color = overrides.colorMode === "ansi256" ? "ansi256" : overrides.colorMode;
  }
  if (overrides.graphics) {
    result.graphics = { ...result.graphics, ...overrides.graphics };
  }
  if (overrides.images !== undefined) {
    result.graphics = imageProfileGraphics(overrides.images);
  }
  if (overrides.scrollback !== undefined) result.scrollback = overrides.scrollback;
  return result;
}

/** 在保持来源信息不变的前提下合并正交覆盖，并让 DA1 与最终 graphics 对齐。 */
export function applyTerminalProfileOverrides(
  profile: ResolvedTerminalProfile,
  overrides: TerminalProfileOverrides = {},
): ResolvedTerminalProfile {
  const capabilities = applyCapabilityOverrides(profile.capabilities, overrides);
  return {
    ...profile,
    env: { ...profile.env },
    replies: completeReplies({ ...profile.replies }, capabilities),
    capabilities,
  };
}

export function defaultTerminalProfile(
  graphics?: TerminalGraphicsCapabilities,
  scrollback?: number,
): ResolvedTerminalProfile {
  const preset = findTerminalPreset("xterm-256color");
  if (!preset) throw new TuiLensError("INVALID_PROFILE", "缺少内置 xterm-256color profile");
  const profile = fromPreset(preset, preset.key);
  return applyTerminalProfileOverrides(profile, {
    ...(graphics ? { graphics } : {}),
    ...(scrollback === undefined ? {} : { scrollback }),
  });
}

export { listTerminalProfiles };
