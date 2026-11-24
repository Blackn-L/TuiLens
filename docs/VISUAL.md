# Visual comparison

[English](VISUAL.md) · [简体中文](zh-CN/VISUAL.md)

`compareImages(actual, baseline, options)` compares static PNG buffers.
`manager.compare(id, options)` captures the terminal and writes a diff/report without modifying the baseline.

| Option | Meaning |
| --- | --- |
| pixelThreshold | Maximum permitted channel difference, integer 0–255; default 0 |
| maxDiffRatio | Maximum differing fraction of unmasked pixels, 0–1; default 0 |
| masks | Pixel rectangles relative to the captured PNG, not terminal cells |
| cursor | `hide` (default) or `show` when capturing the actual image |

The result includes `pass`, `differentPixels`, `totalPixels`, `diffRatio`, dimensions and `diffPng`.
The artifact interface saves the PNG and returns paths instead of the buffer.
Overlapping masks are counted once. Fully masked images fail with `EMPTY_COMPARISON`.
Dimension mismatch fails with `IMAGE_DIMENSIONS_MISMATCH`.

Colors are compared after compositing onto both black and white: invisible RGB is ignored while visible alpha changes remain detectable.
Changed pixels are red; excluded pixels are blue. Keep the actual, baseline and diff together when reviewing failures.

Inputs must be regular files when using the artifact API. Reads are bounded from a single descriptor.
The decoder accepts static, non-interlaced 8-bit PNG only: 32 MiB compressed, maximum side 8192,
maximum 16777216 pixels, with container/CRC checks before accepting decoded output.

Fix font, browser, renderer, scale, terminal size and image mode for each baseline. The actual renderer is
written to observation and comparison metadata; re-record baselines when switching between `dom` and `webgl`.
Sessions start in `headless`; `manager.compare()` and screenshot captures activate `VisualRenderer` on demand.
If the 4 MiB replay window was truncated, `visualSyncDegraded` is set and the capture may not represent full history.
Mask only known nondeterministic regions.
Captures hide the cursor by default; set `cursor: "show"` when cursor pixels are part of the expected baseline.
Accepting a new baseline is an explicit file operation; comparisons never approve updates automatically.

## Pinning the capture font

Chromium cannot read fonts private to a terminal package. In particular, Windows Terminal's bundled
`Cascadia Mono` is not a system font, and its bundled build does not necessarily cover all circled numerals.
The DOM/WebGL visual renderer therefore injects `unicode-range`-scoped local faces from `Noto Sans`,
`MS PGothic`, `Segoe UI Symbol`, and `Apple Symbols`. They affect only circled numerals, so
`⓪` and `⑪`–`⑳` do not reach Consolas at a smaller optical size and the main ASCII/CJK font
selection remains unchanged.

For an exact font identity, set `TUILENS_FONT_FILE` or `ManagerOptions.fontFile` to a `.ttf`, `.otf`,
`.woff` or `.woff2` file. The file is bounded, embedded as a `FontFace`, and its hash appears in
`snapshot.render.fontHash`. It only supplies glyphs present in the file; missing characters continue
through the fallback stack. Apply the same setting to replay. Re-record baselines after changing a font.
`probe --font-file <path> --strict-font` treats inconsistent circled-numeral glyph metrics as a failure.
`fontScale` is a Canvas metric heuristic: it detects inconsistent scale, not the exact font used for
each character.
