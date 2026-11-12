import type { TerminalPresetDefinition } from "./types.js";

export const xtermPreset = {
  key: "xterm-256color",
  aliases: ["xterm", "xterm-256color-276"],
  name: "xterm-256color-276",
  versionRange: ">=276 <400",
  env: {
    TERM: "xterm-256color",
    TERM_PROGRAM: "xterm",
    TERM_PROGRAM_VERSION: "276",
    COLORTERM: "truecolor",
  },
  replies: {
    da1: "\x1b[?1;2c",
    da2: "\x1b[>0;276;0c",
    xtversion: "\x1bP>|XTerm(276)\x1b\\",
  },
  capabilities: {
    color: "truecolor",
    keyboard: { modifyOtherKeys: 2 },
    mouse: ["1000", "1002", "1003", "1006", "1016"],
    graphics: { sixel: false, kitty: false, iterm: false },
    underlineStyles: ["single", "double"],
    synchronizedOutput: true,
    focusEvents: true,
    hyperlink: true,
    unicodeVersion: "15.0",
    scrollback: 2000,
  },
} satisfies TerminalPresetDefinition;
