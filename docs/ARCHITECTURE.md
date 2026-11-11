# Architecture

[English](ARCHITECTURE.md) · [简体中文](zh-CN/ARCHITECTURE.md)

## Layers

| Directory | Responsibility |
| --- | --- |
| `src/core` | Public types, protocol schemas, input encoding, locators, validation, bounded reads |
| `src/engine` | xterm.js browser adapter, image decoding and rendering, viewport capture |
| `src/session` | PTY lifecycle, ordered output, observation barriers, waits and resource limits |
| `src/recording` | Bounded versioned journals and offline replay |
| `src/visual` | PNG validation, pixel comparison and diff artifacts |
| `src/scenario` | Declarative execution and failure reports |
| `src/transport` | Authenticated local IPC daemon/client and shared dispatch |
| `src/interfaces` | CLI and MCP stdio |

Interfaces delegate to the same application service. Protocol schemas are in core;
scenarios do not import CLI implementations. `TerminalEngine` is the replaceable engine contract.

## Contracts

- Public coordinates are zero-based terminal cells; PNG masks are pixels.
- Wide-character continuation cells have width 0. Locators use buffer cells rather than JavaScript string length.
- Received output is batched, then applied in order. Input and resize seal earlier batches before entering the queue.
- A capture reads state and PNG behind one observation barrier; newer output queues until capture ends.
- Synchronized output must finish before capture. `FRAME_PENDING` retries happen outside the queue.
- Explicit `clickText.allowPendingFrame` permits pending character-buffer targeting while retaining the region guard; screenshots remain strict.
- Wheel input supports page expansion and bounded top/bottom navigation; it does not invent application-independent absolute scroll offsets.
- Image decode is part of ordered processing. Only enabled protocols are advertised.
- Resize delivery and application layout completion are separate. Callers wait for visible layout conditions.
- Input reads lightweight dimensions/modes. Guards are checked immediately before input, and cancelled queued actions are dropped.
- Simple text waits probe the engine without transferring the full grid until a match; captures still wait for rendering.
- Automatic terminal replies can be forwarded or dropped by latency policy; suppress drops recognized replies rather than all input. Screenshots hide the cursor by default while snapshots retain visibility, style and blink metadata.
- Capture forces a repaint and validates the grid and PNG dimensions; resize waits for stable canvas geometry.
- inputAndWait sends one action and waits for observable evidence without automatic retry; timeouts retain accepted-input evidence.
- A changed global frame rejects a frame guard. A region fingerprint can tolerate animation outside the target.
- Replays and live sessions share an eight-operation budget and manager shutdown lifecycle.
- Recordings are opt-in. They retain terminal content and mark dropped/truncated output explicitly.
- Baseline images are never overwritten by comparisons.
- Scenario failure attempts bounded evidence capture and always closes its session.

## Bounds

Output batches contain at most 32K UTF-16 units without splitting surrogate pairs.
8 MiB of queued output pauses PTY reading; below 4 MiB resumes; over 16 MiB is a visible error.
Recording files have explicit byte limits. Replay, PNG reads and image placement metadata also have independent limits.
See [images](IMAGES.md), [recording](RECORDING.md), and [visual testing](VISUAL.md).

Windows uses named pipes; Linux uses abstract Unix sockets. A local token authenticates requests.
The daemon verifies live endpoints instead of treating an on-disk state file as proof of liveness.
MCP disconnect cancels pending requests and releases connection-owned sessions.

The browser path is an observation environment, not a zero-overhead performance probe.
[Performance boundaries](PERFORMANCE.md) remain part of every measurement claim.
