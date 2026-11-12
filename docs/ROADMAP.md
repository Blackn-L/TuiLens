# Roadmap

[English](ROADMAP.md) · [简体中文](zh-CN/ROADMAP.md)

## Implemented

- SIXEL and bounded Kitty inline/virtual placement subset.
- iTerm2 OSC 1337 inline images and multipart transport (0.3).
- Region screenshots, read-only baselines, masks and diff artifacts.
- Drag, explicit mouse down/up, modifiers and coordinate-aware wheel input.
- Bounded recording, output replay and declarative scenarios.
- Style-aware unique/nth locators and frame/region guards.
- Terminal reply latency guard, inputAndWait, click hit areas, cursor metadata,
  screenshot cursor hiding, render stabilization and Windows bare-command resolution (0.4).
- Packed snapshot transport and on-demand character grids (unreleased).
- Kitty keyboard protocol and `modifyOtherKeys` encoding (unreleased).
- Shared browser host, configurable session limit, scrollback assertions (unreleased).
- Performance scenarios with baselines and regression gating (unreleased).
- Assertion layer, JUnit output and CI evidence archiving (unreleased).

## Next

- Terminal capability profiles: composable DA1/DA2/XTVERSION replies, `TERM`, colour and
  graphics capabilities, and a preset registry for common terminals and versions.
- Move regional condition evaluation into the engine to reduce full-grid transfers.
- Add explicit rendering metadata, font fingerprints and cross-engine width checks.
- Expand tested image protocol semantics without advertising unsupported behavior.
- Isolate PTY workers to reduce native-module failure and teardown impact.
- Extend `perf` with frame-level paint timing rather than condition-satisfied timing.
- Evaluate a native processing engine using measured parser/IPC/rendering costs.
- Add optional read-only live monitoring and explicit human control handoff.

A browser-free engine still needs reproducible overhead measurements; changing language alone does not guarantee accuracy.
