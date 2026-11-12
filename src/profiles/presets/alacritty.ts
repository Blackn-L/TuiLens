import type { TerminalPresetDefinition } from "./types.js";

export const alacrittyPreset = {
  key: "alacritty",
  aliases: ["alacritty-0.13"],
  name: "alacritty-0.13",
  versionRange: ">=0.12 <1",
  env: {
    TERM: "alacritty",
    TERM_PROGRAM: "Alacritty",
    TERM_PROGRAM_VERSION: "0.13.2",
    COLORTERM: "truecolor",
  },
  replies: {
    da1: "\x1b[?6c",
    da2: "\x1b[>0;13;0c",
    xtversion: "\x1bP>|Alacritty 0.13.2\x1b\\",
  },
  capabilities: {
    color: "truecolor",
    keyboard: { kitty: 1, modifyOtherKeys: 2 },
    mouse: ["1000", "1002", "1003", "1006", "1016"],
    graphics: { sixel: false, kitty: false, iterm: false },
    underlineStyles: ["single", "double", "curly"],
    synchronizedOutput: true,
    focusEvents: true,
    hyperlink: true,
    unicodeVersion: "15.0",
    scrollback: 2000,
  },
} satisfies TerminalPresetDefinition;
