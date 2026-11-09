# Image support and region capture

[English](IMAGES.md) · [简体中文](zh-CN/IMAGES.md)

`launch.images` is `off` (default), `sixel`, or `all`.
`all` enables SIXEL plus the Kitty subset below, not the entire Kitty specification.
Only enabled capabilities are advertised. Character pixel dimensions come from the actual terminal canvas.

## SIXEL

Uses `@xterm/addon-image 0.9.0`; initialization waits for the public image-query readiness probe.
SIXEL capability is advertised via DA1 attribute 4. Writes await parsing; screenshots await rendering.
Limits: 4M pixels per image, 8 MiB per sequence, 32 MiB cache. IIP is disabled.
Scrolling and text overwrite follow the addon's cell model; cursor policies may differ from other terminals.

## Kitty subset

The browser adapter supports:

- Inline `t=d`; PNG `f=100`, RGB `f=24`, RGBA `f=32`.
- Transfer `a=t`, transfer-and-place `a=T`, place `a=p`, query `a=q`.
- Chunked `m=1/0` transfer, including APC sequences split across writes.
- Explicit IDs, updates, deletion `d=i/I/a/A`, and quiet modes `q=0/1/2`.
- Direct cell-rectangle placement and cursor preservation with `C=1`.
- `U=1` virtual placement with foreground-encoded IDs and Unicode row/column placeholders.
- Virtual image tiles following buffer scrolling and text occlusion.

Virtual placement supports only `p=0` and preserves aspect ratio. Display-only placeholder suppression
prevents missing-glyph boxes while preserving the terminal buffer.
Direct placement uses line markers and content invalidation. EL 0/1/2 applies only to intersecting cells.
Same-content redraw, complex scrolling regions and full layering semantics are not guaranteed;
prefer virtual placement or explicit delete/reposition where appropriate.

Unsupported: file/shared-memory transport, compression, animation/APNG, crop, arbitrary z layers,
relative placement, automatic IDs, and nonzero virtual placement IDs. Unsupported requests return protocol errors unless silenced.

Independent bounds apply before allocation: 4M pixels and 4096 pixels per side; 32 MiB bitmap cache;
128 images; 256 placements; 65536 cumulative declared placement cells, including offscreen cells.
PNG container/CRC validation precedes browser decoding. Old images are evicted when the cache fills.

## Capture

```json
{ "x": 2, "y": 1, "width": 10, "height": 4 }
```

`observe.region` uses zero-based cells and must fit the viewport. Pixel edges round outward using actual cell geometry.
PNG dimensions are taken from the resulting image. Text, SIXEL and Kitty layers are included.
The crop affects the PNG only; state can retain the entire viewport.

Generated-pattern tests verify pixels, capabilities, updates, deletion, virtual scrolling/occlusion, limits and crop geometry.
They do not certify complete protocol equivalence with every terminal host.
