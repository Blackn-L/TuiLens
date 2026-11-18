# Architecture

[English](ARCHITECTURE.md) · [简体中文](zh-CN/ARCHITECTURE.md)

## Layers

| Directory | Responsibility |
| --- | --- |
| `src/core` | Public types, protocol schemas, input encoding, locators, validation, bounded reads, error catalog |
| `src/engine` | xterm.js browser adapter, shared browser host, snapshot codec, image decoding and rendering, viewport capture |
| `src/profiles` | Built-in terminal presets, JSON profile inheritance, capability/reply resolution |
| `src/session` | PTY lifecycle, optional PTY worker, ordered output, observation barriers, waits and resource limits |
| `src/recording` | Bounded versioned journals and offline replay |
| `src/visual` | PNG validation, pixel comparison and diff artifacts |
| `src/scenario` | Declarative execution and failure reports |
| `src/perf` | Performance scenarios, process-tree sampling, statistics and baseline comparison |
| `src/testing` | Playwright-style assertions and JUnit XML rendering |
| `src/transport` | Authenticated local IPC daemon/client and shared dispatch |
| `src/interfaces` | CLI and MCP stdio |
| `src/doctor.ts` | Local diagnostics for runtime, browser, PTY, storage and daemon state without starting the daemon |
| `src/probe.ts` | Fixed-glyph rendering probe and font/grid fingerprint report |

Interfaces delegate to the same application service. Protocol schemas are in core;
scenarios do not import CLI implementations. `TerminalEngine` is the replaceable engine contract.

The browser engine uses xterm.js's DOM renderer by default. Opt-in WebGL is loaded from
`@xterm/addon-webgl`; if activation fails, the page falls back to DOM. The engine returns the actual
renderer, which is propagated to sessions, recording headers, scenario/perf environments and visual metadata.

## Transport and sharing

- A `SessionManager` owns one `BrowserHost`. Each session acquires a reference and gets its own browser
  context and page; the browser process starts once and is shared. `shutdownEngine` runs after all sessions
  close, never before.
- `createBrowserEngine` still creates an isolated host for callers that want one browser per engine.
- `maxSessions` (default 8, `TUILENS_MAX_SESSIONS`) caps sessions plus offline replays; matrix testing needs a
  higher value. When a launch finds the budget full, the oldest exited sessions are reclaimed first; running
  sessions are never evicted automatically.

## Snapshot codec

The character grid never crosses the Playwright boundary as an object graph. Inside the page it is packed into
two strings — a token stream per row and a style run-length stream per row — and Node unpacks it into
`TerminalCell[][]`. Unpacking validates row count, cell count and style coverage; a mismatch raises
`INVALID_SNAPSHOT` rather than silently filling defaults.

`cells:false` skips packing entirely. Callers that only need text, size, cursor or a screenshot use it;
`observe` over CLI/MCP does so unless `includeCells` is requested.

## Contracts

- Public coordinates are zero-based terminal cells; PNG masks are pixels.
- Wide-character continuation cells have width 0. Locators use buffer cells rather than JavaScript string length.
- Received output is batched, then applied in order. Input and resize seal earlier batches before entering the queue.
- A capture reads state and PNG behind one observation barrier; newer output queues until capture ends.
- Synchronized output must finish before capture. `FRAME_PENDING` retries happen outside the queue.
- Explicit `clickText.allowPendingFrame` permits pending character-buffer targeting while retaining the region guard; screenshots remain strict.
- Wheel input supports page expansion and bounded top/bottom navigation; it does not invent application-independent absolute scroll offsets.
- Image decode is part of ordered processing. Only enabled protocols are advertised.
- Terminal identity is a resolved profile. It drives environment, image protocols, scrollback and
  DA1/DA2/XTVERSION/Kitty replies; Windows uses the bundled ConPTY DLL plus a final pre-PTY reply rewrite.
- Resize delivery and application layout completion are separate. Callers wait for visible layout conditions.
- Input reads lightweight dimensions/modes. Guards are checked immediately before input, and cancelled queued actions are dropped.
- Simple text waits probe the engine without transferring the full grid until a match; captures still wait for rendering.
- Automatic terminal replies can be forwarded or dropped by latency policy; suppress drops recognized replies rather than all input. Screenshots hide the cursor by default while snapshots retain visibility, style and blink metadata.
- Capture forces a repaint and validates the grid and PNG dimensions; resize waits for stable canvas geometry.
- inputAndWait sends one action and waits for observable evidence without automatic retry; timeouts retain accepted-input evidence.
- `doctor` stays local and does not start the daemon. `ping` exposes uptime and live session counts; `shutdown` is idempotent when no daemon is running.
- Exited sessions remain observable at normal capacity. A new launch under capacity pressure reclaims the oldest
  exited sessions before reporting `SESSION_LIMIT`; explicit `close` still releases them immediately.
- `observe.compact` keeps line count, trims line ends, omits cells and defaults to no screenshot. Regional text/style waits use the engine-side `probeText` path.
- `snapshot.render` records renderer, font/grid metrics, a timing-independent fingerprint and the latest `paintMs`; `probe` compares fixed glyph widths.
- A configured font file is read with a byte limit, embedded as a `FontFace` before xterm starts, and represented by a SHA-256 prefix in `snapshot.render`; generic monospace stays after symbol/CJK fallbacks.
- `TUILENS_PTY_WORKER=1` moves `node-pty` into a per-session child process. The default fast path remains in-process; neither mode is a sandbox.
- `watch` is a read-only JSONL stream by default; `--control` requires a TTY and explicitly forwards input.
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
