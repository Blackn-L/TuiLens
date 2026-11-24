# Architecture

[English](ARCHITECTURE.md) · [简体中文](zh-CN/ARCHITECTURE.md)

## Layers

| Directory | Responsibility |
| --- | --- |
| `src/core` | Public types, protocol schemas, input encoding, locators, validation, bounded reads, error catalog |
| `src/engine` | Browser-free `@xterm/headless` core, lazy browser visual layer, shared browser host, image decoding, viewport capture |
| `src/profiles` | Built-in terminal presets, JSON profile inheritance, capability/reply resolution |
| `src/session` | PTY lifecycle, optional PTY worker, ordered output, observation barriers, waits and resource limits |
| `src/recording` | Bounded versioned journals and offline replay |
| `src/visual` | PNG validation, pixel comparison and diff artifacts |
| `src/scenario` | Declarative execution and failure reports |
| `src/perf` | Performance scenarios, process-tree sampling, statistics and baseline comparison |
| `src/testing` | Playwright-style assertions and JUnit XML rendering |
| `src/transport` | Authenticated persistent IPC v2 daemon/client, multiplexed dispatch and server-pushed events |
| `src/interfaces` | CLI and MCP stdio |
| `src/doctor.ts` | Local diagnostics for runtime, browser, PTY, storage and daemon state without starting the daemon |
| `src/probe.ts` | Fixed-glyph rendering probe and font/grid fingerprint report |

Interfaces delegate to the same application service. Protocol schemas are in core;
scenarios do not import CLI implementations. `TerminalEngine` is the replaceable engine contract.

Every session starts with a browser-free `TerminalCore` backed by `@xterm/headless`. It owns ordered
VT parsing, frame state, scrollback, text probes and terminal replies. `VisualRenderer` wraps Chromium,
the xterm.js DOM/WebGL surface and image addons; it is created only when launch explicitly requests
`dom`/`webgl`, an image protocol is enabled, or a screenshot/visual comparison/paint is requested.

When activated mid-session, `VisualRenderer` replays the bounded output ring (4 MiB by default), waits
for two painted frames, then remains synchronized by receiving future writes and resizes. The engine
reports `headless`, `dom` or `webgl` from live state, and sets `visualSyncDegraded` if replay history
was truncated.

## Transport and sharing

- A `SessionManager` owns one lazy `BrowserHost`. Pure-text sessions never acquire a browser;
  the first visual session starts Chromium once, and later visual sessions share it with their own
  context and page. `shutdownEngine` runs after all sessions close, never before.
- `createBrowserEngine` keeps an isolated lazy host for callers that want one browser per engine.
- `maxSessions` (default 8, `TUILENS_MAX_SESSIONS`) caps sessions plus offline replays; matrix testing needs a
  higher value. When a launch finds the budget full, the oldest exited sessions are reclaimed first; running
  sessions are never evicted automatically.

## Snapshot codec

The browser-free core reads `TerminalCell[][]` directly from `@xterm/headless`; it is the canonical state
source for text, cells, style, cursor and mode guards. Once a visual layer is active, visual snapshots
only contribute renderer/font metadata and never replace core cells. This keeps region fingerprints
stable across the lazy transition.

The optional page snapshot uses the existing Playwright codec: two strings per row, one token stream
and one style run-length stream. Unpacking validates row count, cell count and style coverage; a mismatch
raises `INVALID_SNAPSHOT` rather than silently filling defaults.

`cells:false` skips packing entirely. Callers that only need text, size, cursor or a screenshot use it;
`observe` over CLI/MCP requests cells only for `view:"cells"`.

## Engine boundary

`TerminalCore` now covers the browser-free path for PTY output, parsing, text waits, scrollback,
keyboard/mouse mode mirroring and snapshot cells. Browser Chromium remains the measured fidelity layer
for PNG output, font fallback and the implemented image protocols; its cold-start and RSS cost is paid
only by sessions that request those features.

Callers must stay on the public `TerminalEngine` contract and must not depend on Playwright internals.
See [performance](PERFORMANCE.md), [images](IMAGES.md) and [roadmap](ROADMAP.md).

## Contracts

- Public coordinates are zero-based terminal cells; PNG masks are pixels.
- The default engine is `headless`. A normal observe/find/wait path does not load Playwright or start Chromium.
- `TerminalCore` is the canonical snapshot source after visual activation; the browser contributes only render metadata.
- A bounded 4 MiB replay ring restores history when the visual layer attaches; truncation sets `visualSyncDegraded`.
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
- `observe` defaults to `view:"compact"`; `full` omits cells without trimming, `cells` returns the grid,
  and `diff` compares against one of 16 bounded lightweight frames. Screenshots are opt-in for every view.
  Regional text/style waits use the engine-side `probeText` path.
- `snapshot.render` records renderer, font/grid metrics, a timing-independent fingerprint and the latest `paintMs`; `probe` compares fixed glyph widths.
- A configured font file is read with a byte limit, embedded as a `FontFace` before xterm starts, and represented by a SHA-256 prefix in `snapshot.render`; `unicode-range`-scoped symbol faces cover circled numerals without changing primary font selection.
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
The visual replay ring is capped at 4 MiB and 8192 whole output/resize events.
MCP resource reads and tool image content cap screenshots at 32 MiB and artifacts at 16 MiB; artifact
listings scan at most 1024 directory entries and return at most 256 resources. `wait`, `inputAndWait`
and `replay` throttle daemon progress to 100 events; `scenario`/`perf` emit per step/round, and the
MCP adapter coalesces forwarded notifications to 100 per tool call.
See [images](IMAGES.md), [recording](RECORDING.md), and [visual testing](VISUAL.md).

Windows uses named pipes; Linux uses abstract Unix sockets. A local token authenticates requests.
The daemon verifies live endpoints instead of treating an on-disk state file as proof of liveness.
MCP disconnect cancels pending requests and releases connection-owned sessions.

The browser path is an observation environment, not a zero-overhead performance probe.
[Performance boundaries](PERFORMANCE.md) remain part of every measurement claim.
