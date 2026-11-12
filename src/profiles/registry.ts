import { TERMINAL_PRESETS } from "./presets/index.js";
import type { TerminalPresetDefinition } from "./presets/types.js";

function normalized(value: string): string {
  return value.trim().toLowerCase();
}

/** 先匹配键和别名，再匹配 profile 名称；路径解析由此决定是否继续。 */
export function findTerminalPreset(reference: string): TerminalPresetDefinition | undefined {
  const wanted = normalized(reference);
  return TERMINAL_PRESETS.find((preset) =>
    normalized(preset.key) === wanted
    || normalized(preset.name) === wanted
    || (preset.aliases ?? []).some((alias) => normalized(alias) === wanted));
}

export function listTerminalProfiles(): {
  key: string;
  name: string;
  versionRange: string;
  aliases: readonly string[];
}[] {
  return TERMINAL_PRESETS.map((preset) => ({
    key: preset.key,
    name: preset.name,
    versionRange: preset.versionRange,
    aliases: preset.aliases ?? [],
  }));
}
