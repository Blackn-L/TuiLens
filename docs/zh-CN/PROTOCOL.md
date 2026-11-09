# 协议示例

[English](../PROTOCOL.md) · [简体中文](PROTOCOL.md)

CLI 使用 `--json`、`--file` 或 `--stdin`；MCP 接收相同对象。
会话 ID 来自 launch。除明确标注像素的字段外，坐标均为从 0 起算的字符格。

## 精确定位

```json
{
  "id": "SESSION_UUID",
  "text": "Run",
  "region": { "x": 0, "y": 0, "width": 40, "height": 10 },
  "options": { "style": { "bold": true }, "selection": "unique" }
}
```

适用于 find / clickText。selection 支持 all、unique、first、last。
nth 从 0 起算，不能与非 all 选择同时使用。
匹配覆盖的每个字符格都须符合前景、背景、字重、斜体和下划线条件。
find 会为结果返回 frameId 与区域指纹。

## 保护操作与拖拽

```json
{
  "id": "SESSION_UUID",
  "action": { "type": "click", "x": 7, "y": 2 },
  "guard": { "frameId": 12 }
}
```

过期帧返回 STALE_FRAME。也可把 find 返回的区域与指纹传给
`guard.region = { bounds: match.region, fingerprint: match.fingerprint }`。
仅目标区域改变时返回 STALE_REGION，其他区域动画可继续。

```json
{
  "id": "SESSION_UUID",
  "action": {
    "type": "drag", "from": { "x": 2, "y": 3 }, "to": { "x": 20, "y": 3 },
    "steps": 10, "modifiers": { "shift": true }
  }
}
```

mouseDown/mouseUp 使用 x、y、button、modifiers。鼠标要求协商字符格 SGR，拖拽还需移动上报。

## 等待与比较

wait 可组合 text、stable、size、exited，全部条件同时成立才成功。
text 支持 region、style、count；afterFrameId 要求已应用状态比指定帧更新。
resize 后仅 size 条件不够，应加入新位置的可见内容条件。
stable 比较字符和样式，不比较图片像素。

```json
{
  "id": "SESSION_UUID",
  "options": {
    "baseline": "baseline.png",
    "region": { "x": 0, "y": 0, "width": 40, "height": 10 },
    "pixelThreshold": 8, "maxDiffRatio": 0.001,
    "masks": [{ "x": 0, "y": 0, "width": 20, "height": 10 }]
  }
}
```

compare 的 region 为字符格，masks 为裁剪后 PNG 的像素。差异超限返回 pass:false、证据路径及非零 CLI 退出码。
