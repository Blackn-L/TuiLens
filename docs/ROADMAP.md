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

0.5.1–0.5.5 are landed. Version 0.6.0 completed the architecture and reporting work. The current
release, 0.6.1, adds MCP session ownership and explicit handoff. It also fixes caller-relative paths,
Unicode diff regions and performance baseline reporting.

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

### 0.6.0 PR-1 browser-free TerminalCore (landed)

- Make `@xterm/headless` the default parser for text observation, waits, probes and snapshots.
- Lazy-load the Chromium/xterm.js visual layer for explicit DOM/WebGL, image protocols, screenshots and
  visual comparisons; replay a bounded 4 MiB history and expose `visualSyncDegraded`.
- Remove `launch.images`, CLI `--images`, legacy image shorthand mapping and obsolete docs.
- Compare `headless`, `dom` and `webgl` startup/RSS in `benchmark:overhead`.

Exit: pure-text sessions never start Chromium, lazy screenshots match post-activation updates, and all
quality gates pass.

### 0.6.0 PR-2 persistent IPC v2 (landed)

- Replace per-request short connections with one authenticated, multiplexed NDJSON connection.
- Cancel by request ID, bound each connection to 64 in-flight requests, and remove client-side watch
  polling.
- Push `frame`, `exit` and real `scenario`/`perf` progress events from server-side bounded
  subscriptions.
- Reuse the connection across short-lived CLI calls and unref it when idle so processes exit promptly.

Exit: v2 is the only IPC protocol, watch and long-running work stream server events, and cancellation
or shutdown leaves no pending requests or live handles.

### 0.6.0 PR-3 declarative observation and incremental diff (landed)

- Replace overlapping observation booleans with `view: compact | full | cells | diff`.
- Retain 16 lightweight frame snapshots and return changed lines plus a wide-character-aware region.
- Fall back to compact text when `fromFrameId` has been evicted, and make screenshots opt-in.
- Keep whole-grid reads behind `view:"cells"` for precise style work.

Exit: one observation contract covers agent loops, explicit grid inspection and bounded incremental
diff without returning the full viewport on every turn.

### 0.6.0 PR-4 agent-native MCP v2 (landed)

- Forward real daemon progress for wait, inputAndWait, replay, scenario and perf; remove fake
  heartbeats and document the compact -> inputAndWait -> diff loop.
- Add `tuilens://` session, screen, screenshot, metrics and artifact resources with bounded reads and
  strict artifact containment checks.
- Add bilingual bug-reproduction and visual-regression prompts plus `tuilens mcp-config` for Codex,
  Claude Code, Cursor, Gemini CLI and generic JSON clients.
- Make npm installation the primary onboarding path, document pnpm node-pty approval and keep the
  browser requirement limited to visual features.

Exit: long calls report real progress, resources and prompts are discoverable, artifact traversal is
rejected, and client setup works without hand-writing absolute paths.

### 0.6.0 PR-5 evidence bundle and HTML reports (landed)

- Add versioned scenario, perf and recording evidence manifests with explicit artifact roles.
- Render zero-dependency single-file HTML reports with timelines, compare sliders, SVG charts and
  matrix tabs; escape all dynamic content and use script-safe JSON.
- Bound inline images at 8 MiB each and 24 MiB total, recording replay text at 2 MiB and RSS timeline
  points at 512.
- Add `scenario --html`, `perf --html`, `tuilens report`, SDK exports and CI artifact generation.
- Finalize npm-first documentation and the 0.6.0 package version.

Exit: all three evidence classes render offline, XSS/limit cases fail safely, and CI archives a
self-contained performance report.

## Later

- Expand tested image protocol semantics without advertising unsupported behavior.
- Keep image decoding and pixel capture on the browser path while validating parser/state equivalence.

A fully browser-free visual backend still needs reproducible pixel, font and image-protocol equivalence.
See the engine boundary in [architecture](ARCHITECTURE.md).
