export {
  applyTerminalProfileOverrides, defaultTerminalProfile, imageProfileGraphics, listTerminalProfiles,
  resolveTerminalProfile,
} from "./resolver.js";
export type {
  ResolveTerminalProfileOptions, TerminalProfileOverrides,
} from "./resolver.js";
export { findTerminalPreset } from "./registry.js";
export { TERMINAL_PRESETS } from "./presets/index.js";
