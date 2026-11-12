import type { TerminalCapabilities, TerminalReplies } from "../../core/types.js";

/** 内置 profile 的静态描述；解析后才会补全来源和 DA1 应答。 */
export interface TerminalPresetDefinition {
  key: string;
  aliases?: readonly string[];
  name: string;
  versionRange: string;
  env: Record<string, string>;
  replies: TerminalReplies;
  capabilities: TerminalCapabilities;
}
