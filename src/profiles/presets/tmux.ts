import type { TerminalPresetDefinition } from "./types.js";

export const tmuxPreset = {
  key: "tmux",
  aliases: ["screen", "screen-256color", "tmux-3.4"],
  name: "tmux-3.4",
  versionRange: ">=3.2 <4",
  env: {
    TERM: "screen-256color",
    TERM_PROGRAM: "tmux",
    TERM_PROGRAM_VERSION: "3.4",
    COLORTERM: "truecolor",
  },
  replies: {
    da1: "\x1b[?1;2c",
    da2: "\x1b[>83;40003;0c",
    xtversion: "\x1bP>|tmux 3.4\x1b\\",
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
    unicodeVersion: "15.0",
    scrollback: 2000,
  },
} satisfies TerminalPresetDefinition;
