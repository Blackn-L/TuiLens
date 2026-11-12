import { alacrittyPreset } from "./alacritty.js";
import { iterm2Preset } from "./iterm2.js";
import { kittyPreset } from "./kitty.js";
import { linuxPreset } from "./linux.js";
import { tmuxPreset } from "./tmux.js";
import { vscodePreset } from "./vscode.js";
import { weztermPreset } from "./wezterm.js";
import { windowsTerminalPreset } from "./windows-terminal.js";
import { xtermPreset } from "./xterm.js";
import type { TerminalPresetDefinition } from "./types.js";

export const TERMINAL_PRESETS: readonly TerminalPresetDefinition[] = [
  kittyPreset,
  weztermPreset,
  iterm2Preset,
  windowsTerminalPreset,
  alacrittyPreset,
  vscodePreset,
  tmuxPreset,
  xtermPreset,
  linuxPreset,
];

export type TerminalPresetKey = (typeof TERMINAL_PRESETS)[number]["key"];
