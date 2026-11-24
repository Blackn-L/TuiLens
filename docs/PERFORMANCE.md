# Performance measurement

[English](PERFORMANCE.md) · [简体中文](zh-CN/PERFORMANCE.md)

Text-only sessions use `TerminalCore` without loading Playwright or starting Chromium.
Once a session requests visual output, browser IPC and rendering costs remain part of that session.
Always identify the workload, terminal engine, platform and collection method.

## Application performance (`perf`)

`perf` answers "did my TUI get slower over long sessions", not "how fast is TuiLens".
A baseline is optional: omit `--baseline` for a report-only run, or use `--write-baseline` to create
one for your own application and environment.

```sh
node dist/src/interfaces/cli.js perf --file examples/perf.json --write-baseline artifacts/perf-baseline.json
node dist/src/interfaces/cli.js perf --file examples/perf.json --baseline artifacts/perf-baseline.json
```

| Field | Meaning |
| --- | --- |
| `elapsedMs.p50/p95/p99` | Input sent → target condition satisfied, measured with no screenshots and no full-grid reads |
| `stability` | `max ÷ p50`; < 1.25 stable, < 2 noisy, otherwise unstable |
| `processTree.peakRssBytes` | Peak RSS of the **application's** process tree, sampled once per second |
| `processTree.peakRootRssBytes` | Peak RSS of the root process only |
| `processTree.errors` / `lastError` | Failed process-tree samples and the most recent failure reason |
| `startupMs` | Launch through the declared `ready` condition |
| `session` | Received/applied bytes and write batches per round |
| `comparisons` | Change against the baseline, per metric; empty without a baseline |

Measurement discipline enforced by the runner:

- Every round restarts the application, so caches and history never leak between rounds.
- `setup` steps rebuild state per round, so "long history" is genuinely re-created rather than accumulated.
- `{{seq}}` expands to the running input counter. A fixed evidence string would match text that already exists,
  turning the measurement into a near-zero sample; every sample must wait for its own new evidence.
- Measurement uses `cells:false`, so the tool never reads an 8000-cell grid per sample.
- `ready` is required in practice: input sent before the application enters raw mode is swallowed and
  produces a false timeout.
- A sample that times out fails its round; it is never recorded as a large but passing number.

`processTree.peakRssBytes` is a **lower bound**: sampling costs roughly hundreds of milliseconds on Windows,
so the default interval is one second and `approximate:true` is always reported.

Baselines are optional measurement snapshots tied to a workload and environment. They store `platform`, `node`,
`arch`, `cols` and `rows`. A mismatched environment is refused unless
`allowEnvironmentMismatch`/`--allow-env-mismatch` is set, because absolute latencies are not comparable across
different runners. The TuiLens repository does not ship a baseline; CI runs the example as a report-only smoke
test instead of requiring a repository baseline.

## Tool overhead (`benchmark:overhead`)

```sh
npm run benchmark:overhead -- --frames 120 --repeats 3 --pace-ms 1 \
  --renderers headless,dom,webgl --out artifacts/overhead.json
```

The same native PTY fixture runs in isolated workers with alternating order:

- `drain-only`: consumes output without ANSI parsing or drawing.
- `tuilens-headless`: uses `TerminalCore`, without screenshots or full-grid polling.
- `tuilens-dom`: eagerly activates the DOM renderer before the fixture starts.
- `tuilens-webgl`: eagerly activates WebGL, falling back to DOM if the context is unavailable.

One final screen read validates the completion marker outside the measurement window.

| Metric | Scope |
| --- | --- |
| engineStartupMs | Engine factory only; `headless` parses without Chromium, DOM/WebGL includes browser startup |
| startupMs | Module, PTY, renderer and fixture readiness; DOM/WebGL includes Chromium cold start |
| workload.elapsedMs | Fixture-reported output production time |
| controlToOutputAppliedMs | Control input to final output consumption/parser completion |
| rootCpuMs | Tool worker root-process CPU |
| rootRssPeakBytes | Sampled root-process RSS peak |
| treeRssPeakBytes | Sampled RSS peak across the tool worker and all descendants, including the same fixture, PTY host and activated Chromium |
| sessionMetrics | Received/applied bytes, queue peaks, pauses and batches |

Root CPU/RSS excludes Chromium, the PTY host and workload; `treeRssPeakBytes` includes those children,
but the workload is identical across compared modes.
Parser completion is not pixel presentation.
`engineStartupMs` isolates the engine constructor from module import and PTY fixture startup.
The PTY may transform or coalesce output, so produced and received byte counts are distinct.

## Snapshot transport

Character grids cross the browser boundary as two packed strings (`snapshot-codec.ts`) rather than as a nested
object array. Measured at 160×50 on a desktop Windows host:

| Operation | Before | After |
| --- | --- | --- |
| `observe` (no grid) | ~770 ms | ~2.7 ms |
| `observe` (with grid) | ~770 ms | ~4.1 ms |
| `find` | ~940 ms | ~5 ms |
| `wait` (already satisfied) | ~940 ms | ~4 ms |
| `wait` timeout (1 s) | ~2000 ms | ~1.1 s |

The previous cost was Playwright serialization of 8000 nested cell objects: ~660 ms versus ~7 ms for the same
payload as a flat string. Packing happens inside the page; unpacking and validation happen in Node.

Wait polling now backs off from 2 ms to 50 ms. The old fixed 50 ms tick both quantized short waits and inflated
`perf` results, because a 4 ms observation could only be sampled every 50 ms.

## Frame paint and soak

`snapshot.render.paintMs` records the most recent write-to-two-animation-frame interval. The renderer fingerprint
excludes this timing value, so font/grid identity stays stable across paints. `perf` also records `paintMs`
by waiting for the engine paint boundary when supported.

Run a bounded soak without a real application:

```powershell
$env:TUILENS_SOAK_FRAMES = "500"
npm run soak
```

The JSON result reports elapsed time, root RSS/heap and the last paint sample. It is a bounded tool check, not a
multi-hour application soak. `watch` streams compact JSONL observations; `--control` is an explicit human handoff
and does not improve measurement quality.

## Boundaries

For long-running tests, fix fonts, grid, engine and browser versions; sample each process tree separately;
record collection overhead and backpressure; and distinguish input delivery, application output, parsing and display.
Short synthetic output tests cannot establish hours-long latency or memory stability.
Native engines and Rust processing layers still require overhead calibration.
The accepted browser-engine costs and replacement gates are recorded in [architecture](ARCHITECTURE.md).

The browser path is an observation environment, not a zero-overhead performance probe. `perf` measures the
application through that environment, so the tool's own cost is a constant offset, not the reported metric.

