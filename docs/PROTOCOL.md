# Protocol examples

[English](PROTOCOL.md) · [简体中文](zh-CN/PROTOCOL.md)

CLI payloads use `--json`, `--file`, or `--stdin`. MCP tool arguments use the same object.
Session IDs are returned by launch. Coordinates are zero-based cells unless a field explicitly says pixels.

## Local IPC v2

The daemon accepts only persistent NDJSON connections. The first frame authenticates the connection:

```json
{"type":"auth","version":2,"token":"<hex>"}
```

The daemon answers `auth_ok` with its pid and version, or `auth_error` and closes the connection. The
default handshake timeout is 15 seconds. After authentication, one connection multiplexes requests:

```json
{"type":"req","id":"<uuid>","method":"observe","params":{},"stream":true}
{"type":"cancel","id":"<uuid>"}
{"type":"event","id":"<uuid>","event":"frame","data":{}}
{"type":"res","id":"<uuid>","ok":true,"data":{}}
```

Requests are limited to 1 MiB per line and 64 in-flight requests per connection. Cancelling an id
only aborts that request. Reusing an in-flight request ID is a connection-level protocol violation
and closes the connection without a second terminal response. `watch` is a server-pushed stream
(`frame` and `exit` events); the CLI no longer polls `observe`. `wait`, `inputAndWait`, `scenario`,
`perf` and `replay` use `progress` events with `{kind,profile?,current,total,elapsedMs}`. Progress is
throttled, bounded to 100 notifications per operation, and only emitted from real state changes.

## Exact targeting

```json
{
  "id": "SESSION_UUID",
  "text": "Run",
  "region": { "x": 0, "y": 0, "width": 40, "height": 10 },
  "options": { "style": { "bold": true }, "selection": "unique" }
}
```

Use with `find` or `clickText`. `selection` accepts `all`, `unique`, `first`, `last`.
`nth` is zero-based and cannot be combined with a non-`all` selection.
Every covered cell must match the requested foreground, background, bold, italic or underline style.
`find` returns the frame and a region fingerprint for each match.

`clickText` also accepts an explicit hit area:

```json
{
  "id": "SESSION_UUID",
  "text": "Collapse",
  "options": {
    "hitbox": { "right": 3 },
    "point": "right",
    "offset": { "x": 0, "y": 0 },
    "button": "left",
    "modifiers": { "shift": false }
  }
}
```

`hitbox` expands the text bounds in cells; `point` supports `center`, `left`, `right`, `top` and `bottom`.
An expanded hitbox or final point outside the grid returns `INVALID_HITBOX`, and the guard fingerprint covers the full hitbox.

If synchronized output never commits, `clickText` additionally accepts `options.allowPendingFrame:true`.
This is an explicit escape hatch for reading the pending character buffer, not a guarantee of a stable PNG.
The target region is still fingerprint-checked immediately before clicking; frame guards, ordinary observe and screenshots are unchanged.

## Scroll navigation

```json
{ "type": "scroll", "x": 20, "y": 10, "direction": "down", "unit": "page", "amount": 5 }
{ "type": "scroll", "x": 20, "y": 10, "to": "top" }
```

`unit:"page"` expands each requested page to the current terminal row count. `amount` is 1–100 wheel units before expansion.
`to:"top"`/`"bottom"` sends a bounded sequence of up/down wheel events at the chosen coordinates and cannot be combined with
`direction`, `unit` or `amount`. These are application-level navigation requests, not absolute history-row addressing.
The application must enable character-cell SGR mouse reporting; its scrollback size and per-event line consumption still apply.
Use `drag` for scrollbar dragging or `key` for `Home`, `End`, `PageUp` and `PageDown` when the application handles those keys.

`to:"top"`/`"bottom"` is written to the PTY in 20 batches of 100 events, yielding to the event loop between batches.
The total event count is unchanged, but the input is no longer one 20 KB burst and the operation can be cancelled.
A normal wheel scroll remains a single write.

## Scrollback

```json
{ "id": "SESSION_UUID", "screenshot": false, "scrollback": 200 }
```

Returns lines above the viewport in `snapshot.scrollback`, oldest first, text only (no cells). The count is
1–5000. When fewer lines are available than requested, `scrollbackTruncated` is `true`. Use it when the
application hands history to the terminal scrollback rather than repainting it in an alternate screen.

## Terminal profile

```json
{
  "command": "node",
  "args": ["app.mjs"],
  "renderer": "webgl",
  "terminalProfile": "kitty",
  "graphics": { "sixel": false, "kitty": true, "iterm": false }
}
```

`terminalProfile` accepts a built-in preset key/name or a JSON profile path. The returned session includes
the resolved name in `terminalProfile`. `graphics` overrides individual image protocols. See
[terminal profiles](PROFILES.md).

`renderer` accepts `headless` (default), `dom`, or `webgl`. `headless` never loads Chromium. Explicit
`dom`/`webgl`, an enabled image protocol, or the first screenshot/visual comparison activates the visual
layer. The returned session always reflects live state, so it can start as `headless` and later report
`dom`/`webgl`. `visualSyncDegraded: true` means the bounded replay window was truncated during lazy attach.
WebGL failure falls back to DOM and returns `dom`. WebGL may use integer cell widths, so screenshot
dimensions can change; re-record visual baselines when switching renderers.

## Keyboard protocols

`modes.keyboard` reports what the application negotiated:

```json
{ "kitty": 1, "modifyOtherKeys": 2 }
```

- `kitty` is the Kitty keyboard protocol flag set (`CSI > flags u` pushes, `CSI < n u` pops, `CSI = flags ; mode u` updates).
  When non-zero, modified keys are encoded as `CSI code ; modifier u`, so `Shift+Enter` becomes `\x1b[13;2u`.
- `modifyOtherKeys` is the xterm XTMODKEYS level. At level 2, combinations the traditional encoding cannot express
  (`Shift+Enter`, `Ctrl+Space`) use `CSI 27 ; modifier ; code ~`.
- Ctrl+letter keeps its traditional C0 byte (`Ctrl+a` → `\x01`) even under `modifyOtherKeys`, because applications
  depend on those bytes.
- Without a negotiated protocol, `Shift+Enter` and `Ctrl+Space` raise `UNSUPPORTED_KEY` instead of silently sending `\r`.

## Guarded input

```json
{
  "id": "SESSION_UUID",
  "action": { "type": "click", "x": 7, "y": 2 },
  "guard": { "frameId": 12 }
}
```

A stale frame fails with `STALE_FRAME`. Alternatively use
`guard.region = { bounds: match.region, fingerprint: match.fingerprint }` from a prior find result.
The region guard fails with `STALE_REGION` only when the target region changes.

## Drag

```json
{
  "id": "SESSION_UUID",
  "action": {
    "type": "drag",
    "from": { "x": 2, "y": 3 },
    "to": { "x": 20, "y": 3 },
    "steps": 10,
    "modifiers": { "shift": true }
  }
}
```

Explicit `mouseDown`/`mouseUp` use `x`, `y`, `button` and `modifiers`.
Mouse actions require negotiated character SGR; drag requires motion reporting.

## Wait for fresh styled content

```json
{
  "id": "SESSION_UUID",
  "afterFrameId": 12,
  "conditions": [
    { "kind": "text", "text": "Ready", "style": { "bold": true }, "count": 1 },
    { "kind": "stable", "region": { "x": 0, "y": 0, "width": 40, "height": 4 }, "durationMs": 250 }
  ],
  "timeoutMs": 10000
}
```

Conditions are ANDed. Text count is computed after style/region filtering.
`afterFrameId` requires newer applied state. `size` only observes terminal dimensions;
add a visible layout condition after resize. `stable` compares characters and styles, not image pixels.

## Input confirmation

```json
{
  "id": "SESSION_UUID",
  "action": { "type": "text", "text": "PING" },
  "wait": {
    "conditions": [{ "kind": "text", "text": "INPUT_RECEIVED" }],
    "timeoutMs": 10000
  },
  "screenshot": false
}
```

`inputAndWait` sends the input exactly once and never retries it. With no conditions it waits for at least one new `frameId`.
Success returns `session`, `inputFrameId`, `cursorBefore`, `observation` and `elapsedMs`.
A timeout returns `WAIT_TIMEOUT` with `accepted: true` and `inputFrameId`.
A requested screenshot uses a separate bounded capture budget, so a successful wait is not turned into an ambiguous input failure.

A cursor condition can combine `x`, `y`, `visible`, `style` and `blink` with AND semantics.
`observe`/`compare` accept `cursor: "hide"` (default) or `"show"`; snapshots always include cursor metadata.
`observe.view` is one of `compact`, `full`, `cells` or `diff` (default `compact`). `compact` trims line
ends and omits cells, `full` skips compact trimming while omitting cells, and `cells` includes the terminal grid.
`diff` requires `fromFrameId` and returns `diff.changedLines`, `diff.changedRegion` and cursor/mode/resize
flags while omitting the full snapshot text. Frames older than the retained 16-frame ring fall back to a
compact full observation with `diff.fallbackFull:true`. Screenshots require `screenshot:true` for every view.
When a line insertion or deletion changes its display width, `changedRegion` extends through the shifted
suffix to the end of the wider line. An explicitly requested `scrollback` is retained when a diff is
available; otherwise the snapshot omits viewport text and cells.
Regional text/style waits are evaluated in the engine before a light observation is returned.

## MCP resources and prompts

MCP clients can discover these read-only resources:

| URI | MIME | Content |
| --- | --- | --- |
| `tuilens://sessions` | `application/json` | Safe session metadata, no environment variables or credentials. |
| `tuilens://sessions/{id}/screen` | `text/plain` | Compact screen from the browser-free core. |
| `tuilens://sessions/{id}/screenshot` | `image/png` | On-demand screenshot, 32 MiB read cap. |
| `tuilens://sessions/{id}/metrics` | `application/json` | Backpressure and protocol counters. |
| `tuilens://artifacts/{name}` | By extension | Artifact read, 16 MiB cap, strict containment. |

Artifact names are relative to `TUILENS_HOME/artifacts`. Absolute paths, `..`, NUL bytes and symlink
escapes are rejected after `resolve` and `realpath` checks. Prompts are `tui_reproduce_bug` and
`tui_visual_regression`; their descriptions and text follow `TUILENS_LANG`.

## Automatic terminal replies

`protocolReplies.mode:"auto"` forwards only known replies that match a recent query within `maxLatencyMs` (default 250).
`"forward"` disables this filtering; `"suppress"` drops recognized complete DA1/DA2, CPR/DSR and related replies.
Suppress preserves unrelated input instead of dropping all PTY input. Filtering is performed on renderer reply chunks;
an application that probes in cooked/echo mode can still need an app-side probe switch or launch-time `suppress`.
Use `metrics` to inspect forwarded/dropped reply counts. Suppression is not a substitute for correct application TTY mode handling.

## Visual comparison

```json
{
  "id": "SESSION_UUID",
  "options": {
    "baseline": "baseline.png",
    "region": { "x": 0, "y": 0, "width": 40, "height": 10 },
    "cursor": "hide",
    "pixelThreshold": 8,
    "maxDiffRatio": 0.001,
    "masks": [{ "x": 0, "y": 0, "width": 20, "height": 10 }]
  }
}
```

Here `region` is in cells; `masks` is in pixels of the cropped PNG.
A comparison mismatch returns `pass:false`, evidence paths and a nonzero CLI exit status.
