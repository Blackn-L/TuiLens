import type { TerminalPresetDefinition } from "./types.js";

export const kittyPreset = {
  key: "kitty",
  aliases: ["kitty-0.40"],
  name: "kitty-0.40",
  versionRange: ">=0.36 <1",
  env: {
    TERM: "xterm-kitty",
    TERM_PROGRAM: "kitty",
    TERM_PROGRAM_VERSION: "0.40.0",
    COLORTERM: "truecolor",
  },
  replies: {
    da1: "\x1b[?62;22c",
    da2: "\x1b[>0;4000;1c",
    xtversion: "\x1bP>|kitty(0.40.0)\x1b\\",
  },
  capabilities: {
    color: "truecolor",
    keyboard: { kitty: 1, modifyOtherKeys: 2 },
    mouse: ["1000", "1002", "1003", "1006", "1016"],
    graphics: { sixel: false, kitty: true, iterm: false },
    underlineStyles: ["single", "double", "curly"],
    synchronizedOutput: true,
    focusEvents: true,
    hyperlink: true,
    unicodeVersion: "15.1",
    scrollback: 2000,
  },
} satisfies TerminalPresetDefinition;
