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

## Next

- Move regional condition evaluation into the engine to reduce full-grid transfers.
- Add explicit rendering metadata, font fingerprints and cross-engine width checks.
- Expand tested image protocol semantics without advertising unsupported behavior.
- Isolate PTY workers to reduce native-module failure and teardown impact.
- Measure process-tree resources and input latency over fixed, long-running workloads.
- Evaluate a native processing engine using measured parser/IPC/rendering costs.
- Add optional read-only live monitoring and explicit human control handoff.
- Establish release packaging and API compatibility policies.

A browser-free engine still needs reproducible overhead measurements; changing language alone does not guarantee accuracy.
