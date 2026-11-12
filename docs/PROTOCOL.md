# Protocol examples

[English](PROTOCOL.md) · [简体中文](zh-CN/PROTOCOL.md)

CLI payloads use `--json`, `--file`, or `--stdin`. MCP tool arguments use the same object.
Session IDs are returned by launch. Coordinates are zero-based cells unless a field explicitly says pixels.

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
  "terminalProfile": "kitty",
  "graphics": { "sixel": false, "kitty": true, "iterm": false }
}
```

`terminalProfile` accepts a built-in preset key/name or a JSON profile path. The returned session includes
the resolved name in `terminalProfile`. `graphics` overrides individual image protocols; legacy `images`
still works but maps to the same capabilities. See [terminal profiles](PROFILES.md).

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
