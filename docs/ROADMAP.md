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
- Packed snapshot transport and on-demand character grids (0.5).
- Kitty keyboard protocol and `modifyOtherKeys` encoding (0.5).
- Shared browser host, configurable session limit, scrollback assertions (0.5).
- Performance scenarios with baselines and regression gating (0.5).
- Assertion layer, JUnit output and CI evidence archiving (0.5).
- Local `doctor` diagnostics, daemon counters and idempotent shutdown (0.5).

## 0.5.x plan

0.5.1–0.5.4 are landed. The current patch version is 0.5.5, which closes the release and quality-gate
work instead of deferring it.

### 0.5.0 Delivery foundation (landed)

- Add `doctor` for runtime, browser, `node-pty`, storage and daemon diagnostics.
- Expose daemon uptime and live session/launch/replay counts from `ping`.
- Make `shutdown` idempotent and handle Windows `SIGBREAK` plus POSIX `SIGHUP`.
- Record stale daemon metadata without deleting it automatically.
- Cover Node.js 22 and 24 on Windows and Linux in CI.

Exit: diagnostic and lifecycle checks pass on Windows and Linux; no publishing dependency.

### 0.5.1 Compact agent observation (landed)

- Add a compact screen view for text, cursor, frame and region summaries.
- Move regional text/style/stable evaluation behind the engine boundary.
- Return only match evidence and fingerprints when full cells are not required.

Exit: representative read/wait loops transfer less data and preserve existing semantics.

### 0.5.2 Long-running MCP and PTY isolation (landed)

- Add MCP progress and cancellation coverage for waits, scenarios and performance runs.
- Isolate PTY workers to reduce native-module failure and teardown impact.
- Add crash/recovery tests that verify session ownership and cleanup.

Exit: long waits can be cancelled; a PTY failure does not corrupt unrelated sessions.

### 0.5.3 Cross-platform and rendering fidelity (landed)

- macOS joins CI as an experimental platform.
- Add font fingerprints, ambiguous-width/glyph probes and cross-engine comparisons.
- Compare DOM, WebGL and terminal profiles against a fixed fixture matrix.

Exit: supported platforms have CI evidence; visual differences are explainable.

### 0.5.4 Performance and live observation (landed)

- Add frame-level paint timing alongside condition-satisfied latency.
- Add bounded soak tests for long-running sessions.
- Add read-only `watch` JSONL monitoring; `--control` is explicit TTY handoff.

Exit: measured budgets exist before any native-engine rewrite is considered.

### 0.5.5 Release engineering and quality gates (landed)

- Replace `playwright` with `playwright-core`; stable dependencies use SemVer ranges while the
  prerelease `node-pty` pin remains exact.
- Generate the SDK version from `package.json`; publish, GitHub Release and clean-install smoke are
  tag-driven workflows.
- Add Biome lint/format gates, coverage thresholds, scheduled soak runs, dependency drift artifacts and
  Dependabot updates.
- Record the browser renderer boundary and the evidence required before a native/browser-free engine.

Exit: tag builds publish reproducibly, install from the packed tarball, and pass the same checks as CI.

## Later

- Expand tested image protocol semantics without advertising unsupported behavior.
- Evaluate a native processing engine using measured parser, IPC and rendering costs.

A browser-free engine still needs reproducible overhead measurements and renderer equivalence; changing
language alone does not guarantee accuracy. See the renderer exit criteria in
[architecture](ARCHITECTURE.md).
