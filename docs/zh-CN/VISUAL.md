# 视觉比较

[English](../VISUAL.md) · [简体中文](VISUAL.md)

`compareImages(actual, baseline, options)` 比较两张 PNG，返回通过状态、
差异像素数量、未遮罩像素数、差异比例和可保存的差异 PNG。
函数不创建或修改基准图片。

## 选项

| 选项 | 默认值 | 含义 |
| --- | --- | --- |
| `pixelThreshold` | `0` | 允许的每通道最大差值，0～255 的整数 |
| `maxDiffRatio` | `0` | 允许的差异像素比例，0～1 |
| `masks` | `[]` | 比较图片内的像素矩形，忽略其差异 |
| `cursor` | `hide` | 实际截图时隐藏或显示光标 |

遮罩坐标从 0 起算，单位为**像素**，相对于裁剪后图片左上角。
它与终端观察入口使用的字符格区域不同。
遮罩必须完整位于图片内；重叠区域只计算一次，不得遮住整张图片。

差异条件为：像素的最大颜色通道差值大于 `pixelThreshold`。
通过条件为：`differentPixels / totalPixels <= maxDiffRatio`。
`totalPixels` 不包含被遮罩的像素。

透明像素分别在黑、白底色上合成比较。
这会忽略全透明像素里不可见的 RGB，同时捕获在其他底色上可见的透明度变化。

## 差异图

- 红色：超过通道阈值的像素。
- 蓝色：被遮罩、不参与比较的像素。
- 灰色：其余实际画面。

这是严格的通道级比较，不是感知相似度或 OCR。
字体、字体回退、DPI、网格、引擎版本、renderer 和图片解码配置应固定。
实际 renderer 会写入观察和比较元数据；在 `dom` 与 `webgl` 之间切换时需要重新录制基准。
会话默认从 `headless` 开始；`manager.compare()` 和截图会按需激活 `VisualRenderer`。
若 4 MiB 回放窗口被截断，会设置 `visualSyncDegraded`，此时截图可能不代表完整历史。
时间、动画和光标等动态区域应显式遮罩，不能通过扩大容差隐藏布局回归。
实际截图默认隐藏光标；只有基准确实包含光标时才设置 `cursor: "show"`。

## 固定截图字体

Chromium 读不到终端包内的私有字体。Windows Terminal 自带的 `Cascadia Mono` 不是系统字体，
而且随包版本不一定覆盖全部圈码。因此 DOM/WebGL 视觉渲染会注入带 `unicode-range` 的本地字面
`Noto Sans`、`MS PGothic`、`Segoe UI Symbol` 和 `Apple Symbols`，只接管圈码；
这样 `⓪` 和 `⑪`–`⑳` 不会被 Consolas 以更小字阶接管，主 ASCII/CJK 字体选择也保持不变。

需要精确字体身份时，可通过 `TUILENS_FONT_FILE` 或 `ManagerOptions.fontFile` 指定 `.ttf`、
`.otf`、`.woff` 或 `.woff2` 文件。文件有大小上限，会以内联 `FontFace` 加载，并在
`snapshot.render.fontHash` 中记录哈希；它只提供文件实际包含的字形，缺字仍按回退栈继续匹配。
回放应使用同一配置。更换字体后必须重新录制基准。
`probe --font-file <路径> --strict-font` 会把圈码字形度量不一致判为失败。
`fontScale` 是 Canvas 度量启发式：它检测字阶是否一致，不等同于逐字符字体来源验证。

## 输入边界

接受非交错的 8 位静态 PNG。单图最多 32 MiB，
单边最多 8192 像素，总面积最多 16777216 像素。
不接受动画 PNG、尾随数据、越界块、CRC 错误或不完整 PNG。
两图尺寸不同返回 `IMAGE_DIMENSIONS_MISMATCH`，不会缩放或裁掉多余区域。

比较前先检查容器、文件大小和 IHDR 尺寸，再进行解码。
遮罩最多 256 个，累计处理面积有界。
