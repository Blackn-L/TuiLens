import type { TerminalPresetDefinition } from "./types.js";

export const linuxPreset = {
  key: "linux",
  aliases: ["linux-console", "linux-console-6"],
  name: "linux-console-6",
  versionRange: ">=5 <7",
  env: {
    TERM: "linux",
  },
  replies: {
    da1: "\x1b[?6c",
  },
  capabilities: {
    color: "ansi16",
    mouse: [],
    graphics: { sixel: false, kitty: false, iterm: false },
    underlineStyles: ["single"],
    synchronizedOutput: false,
    focusEvents: false,
    hyperlink: false,
    scrollback: 2000,
  },
} satisfies TerminalPresetDefinition;
