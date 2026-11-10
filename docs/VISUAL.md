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

Fix font, browser, scale, terminal size and image mode for each baseline. Mask only known nondeterministic regions.
Captures hide the cursor by default; set `cursor: "show"` when cursor pixels are part of the expected baseline.
Accepting a new baseline is an explicit file operation; comparisons never approve updates automatically.
