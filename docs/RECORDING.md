# Recordings and scenarios

[English](RECORDING.md) · [简体中文](zh-CN/RECORDING.md)

## Recording

Opt in with `launch.recording = { maxBytes: 16777216 }` or CLI `--record`.
The result includes `recordingPath`. NDJSON records contain a versioned header, output, input, resize, exit and end events.
No command, working directory or environment is copied into the header. Terminal content and input themselves may contain sensitive data.

The file limit is 4 KiB–64 MiB. Reaching capacity or discarding received output at close/failure marks it truncated.
A missing end marker is incomplete, not a successful recording. Disabled recording performs no journal I/O.

## Replay

Replay validates the entire bounded file before creating an engine. It applies output and resize only;
input events are informational and never executed. Default `speed=0` applies events immediately.
Positive speed preserves scaled intervals; a delay over 30 seconds between individual events is rejected.

Missing/early end markers, invalid timestamps and unsupported versions fail explicitly.
Truncated replay requires `allowTruncated:true` and remains labeled truncated.
At most 100000 events are accepted. Cancellation closes the replay engine and removes incomplete result artifacts.
Replays share the manager's eight-operation limit and shutdown lifecycle.

Replay checks terminal rendering. To test application behavior, run the actual program with a controlled workload.

## Scenarios

A scenario has `version:1`, `launch`, and up to 500 `steps`.
Supported step types: `input`, `wait`, `resize`, `observe`, `clickText`, `compare`.
See [the runnable example](../examples/scenario.json).

The runner launches one real process. Steps use the same session APIs as CLI/MCP.
On failure, it attempts a bounded screenshot and writes a structured report.
It closes the session on success, failure or cancellation; cleanup failures remain visible in the report.

CLI: `scenario --file scenario.json` reads the specification directly.
MCP: `terminal_scenario` accepts `{ "specification": { ... } }`.
A scenario explicitly launches its configured command, so only run specifications you intend to execute.
