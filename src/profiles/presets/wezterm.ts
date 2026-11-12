import type { TerminalPresetDefinition } from "./types.js";

export const weztermPreset = {
  key: "wezterm",
  aliases: ["wezterm-20240203"],
  name: "wezterm-20240203",
  versionRange: ">=20230712 <2026",
  env: {
    TERM: "xterm-256color",
    TERM_PROGRAM: "WezTerm",
    TERM_PROGRAM_VERSION: "20240203-110809-5046fc22",
    COLORTERM: "truecolor",
  },
  replies: {
    da1: "\x1b[?62;4;22c",
    da2: "\x1b[>1;1000;0c",
    xtversion: "\x1bP>|WezTerm 20240203-110809-5046fc22\x1b\\",
  },
  capabilities: {
    color: "truecolor",
    keyboard: { kitty: 1, modifyOtherKeys: 2 },
    mouse: ["1000", "1002", "1003", "1006", "1016"],
    graphics: { sixel: true, kitty: true, iterm: true },
    underlineStyles: ["single", "double", "curly"],
    synchronizedOutput: true,
    focusEvents: true,
    hyperlink: true,
    unicodeVersion: "15.1",
    scrollback: 2000,
  },
} satisfies TerminalPresetDefinition;
