import type { TerminalPresetDefinition } from "./types.js";

export const iterm2Preset = {
  key: "iterm2",
  aliases: ["iterm", "iterm2-3.5"],
  name: "iterm2-3.5",
  versionRange: ">=3.4 <4",
  env: {
    TERM: "xterm-256color",
    TERM_PROGRAM: "iTerm.app",
    TERM_PROGRAM_VERSION: "3.5.0",
    COLORTERM: "truecolor",
    LC_TERMINAL: "iTerm2",
    LC_TERMINAL_VERSION: "3.5.0",
  },
  replies: {
    da1: "\x1b[?62;4;22c",
    da2: "\x1b[>0;95;0c",
    xtversion: "\x1bP>|iTerm2 3.5.0\x1b\\",
  },
  capabilities: {
    color: "truecolor",
    keyboard: { modifyOtherKeys: 2 },
    mouse: ["1000", "1002", "1003", "1006", "1016"],
    graphics: { sixel: true, kitty: false, iterm: true },
    underlineStyles: ["single", "double", "curly"],
    synchronizedOutput: true,
    focusEvents: true,
    hyperlink: true,
    unicodeVersion: "15.0",
    scrollback: 2000,
  },
} satisfies TerminalPresetDefinition;
