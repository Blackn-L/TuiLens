# Performance measurement

[English](PERFORMANCE.md) · [简体中文](zh-CN/PERFORMANCE.md)

Disabling screenshots does not remove parsing, browser IPC or rendering cost.
Always identify the workload, terminal engine, platform and collection method.

```sh
npm run benchmark:overhead -- --frames 120 --repeats 3 --pace-ms 1 --out artifacts/overhead.json
```

The same native PTY fixture runs in isolated workers with alternating order:

- `drain-only`: consumes output without ANSI parsing or drawing.
- `tuilens`: uses the actual session/browser engine, without screenshots or full-grid polling during measurement.

One final screen read validates the completion marker outside the measurement window.

| Metric | Scope |
| --- | --- |
| startupMs | Module, browser, PTY startup and fixture readiness |
| workload.elapsedMs | Fixture-reported output production time |
| controlToOutputAppliedMs | Control input to final output consumption/parser completion |
| rootCpuMs | Tool worker root-process CPU |
| rootRssPeakBytes | Sampled root-process RSS peak |
| sessionMetrics | Received/applied bytes, queue peaks, pauses and batches |

Root CPU/RSS excludes Chromium, the PTY host and workload. Parser completion is not pixel presentation.
The PTY may transform or coalesce output, so produced and received byte counts are distinct.

For long-running tests, fix fonts, grid, engine and browser versions; sample each process tree separately;
record collection overhead and backpressure; and distinguish input delivery, application output, parsing and display.
Short synthetic output tests cannot establish hours-long latency or memory stability.
Native engines and Rust processing layers still require overhead calibration.
