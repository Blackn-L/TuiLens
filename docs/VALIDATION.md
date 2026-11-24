# Validation

[English](VALIDATION.md) · [简体中文](zh-CN/VALIDATION.md)

```sh
npm run check
npm run lint
npm run format:check
npm test
npm run test:coverage
npm run smoke:install
```

Tests use standalone fixtures and generated image patterns. They require no external application or model service.
`npm run soak` runs a separate bounded render-loop check; set `TUILENS_SOAK_FRAMES` to change its length.
The coverage gate requires 70% lines, 65% branches and 70% functions. `smoke:install` packs the package,
installs it into a clean project and checks the SDK/CLI version.

Coverage includes browser Unicode/styles/modes, synchronized capture, native PTY input and exit,
output backpressure, cancellation, concurrent daemon startup, CLI/MCP cleanup, image pixel rendering,
region capture, visual masks, drag encoding, guarded targeting, recording limits, replay cancellation and scenario failures.
New coverage includes timely/late terminal replies, split queries, suppress policy, reply metrics,
clickText hit areas, one-shot inputAndWait confirmation, cursor metadata, hidden screenshot cursors,
pending-frame click targeting with real PTY input, page/top/bottom scroll encoding,
PNG grid dimensions after resize, doctor checks for runtime/browser/PTY/storage/daemon state,
idempotent daemon shutdown, declarative compact/full/cells/diff observations, engine-side regional probes, MCP progress/cancellation,
optional PTY workers, fixed-glyph rendering probes and JSONL watch. MCP launch is exercised with `colorMode:"truecolor"`.

Inspect captures in `artifacts/engine/`, `artifacts/images/`, and `artifacts/visual/` for glyphs, colors and clipping.
Text assertions alone do not prove visual correctness. CI artifacts are not automatically published because terminal output may contain data.

The Windows `node-pty 1.2.0-beta.18` helper can emit `AttachConsole failed` after natural exit during cleanup.
Tests must confirm eventual process release and retain that diagnostic.
Unit tests do not establish full host-terminal, system IME or clipboard compatibility.
See [performance](PERFORMANCE.md) for benchmark limits and [image support](IMAGES.md) for protocol scope.
