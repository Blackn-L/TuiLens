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

## Visual comparison

```json
{
  "id": "SESSION_UUID",
  "options": {
    "baseline": "baseline.png",
    "region": { "x": 0, "y": 0, "width": 40, "height": 10 },
    "pixelThreshold": 8,
    "maxDiffRatio": 0.001,
    "masks": [{ "x": 0, "y": 0, "width": 20, "height": 10 }]
  }
}
```

Here `region` is in cells; `masks` is in pixels of the cropped PNG.
A comparison mismatch returns `pass:false`, evidence paths and a nonzero CLI exit status.
