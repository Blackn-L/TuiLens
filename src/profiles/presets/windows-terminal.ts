import type { TerminalPresetDefinition } from "./types.js";

export const windowsTerminalPreset = {
  key: "windows-terminal",
  aliases: ["windows", "wt", "windows-terminal-1.21"],
  name: "windows-terminal-1.21",
  versionRange: ">=1.18 <2",
  env: {
    TERM: "xterm-256color",
    TERM_PROGRAM: "Windows_Terminal",
    TERM_PROGRAM_VERSION: "1.21.2911",
    COLORTERM: "truecolor",
  },
  replies: {
    da1: "\x1b[?62;22c",
    da2: "\x1b[>0;10;1c",
    xtversion: "\x1bP>|Windows Terminal(1.21.2911)\x1b\\",
  },
  capabilities: {
    color: "truecolor",
    keyboard: { modifyOtherKeys: 2 },
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
