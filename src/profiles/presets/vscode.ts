import type { TerminalPresetDefinition } from "./types.js";

export const vscodePreset = {
  key: "vscode",
  aliases: ["code", "vscode-1.95"],
  name: "vscode-1.95",
  versionRange: ">=1.85 <2",
  env: {
    TERM: "xterm-256color",
    TERM_PROGRAM: "vscode",
    TERM_PROGRAM_VERSION: "1.95.0",
    COLORTERM: "truecolor",
  },
  replies: {
    da1: "\x1b[?62;22c",
    da2: "\x1b[>0;10;1c",
    xtversion: "\x1bP>|Visual Studio Code(1.95.0)\x1b\\",
  },
  capabilities: {
    color: "truecolor",
    keyboard: { modifyOtherKeys: 2 },
    mouse: ["1000", "1002", "1003", "1006"],
    graphics: { sixel: false, kitty: false, iterm: false },
    underlineStyles: ["single", "double", "curly"],
    synchronizedOutput: true,
    focusEvents: true,
    hyperlink: true,
    unicodeVersion: "15.1",
    scrollback: 2000,
  },
} satisfies TerminalPresetDefinition;
