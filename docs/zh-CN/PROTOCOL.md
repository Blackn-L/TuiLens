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

clickText 还支持真实命中区：

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

hitbox 以文字区域为基准向四周扩展；point 支持 center、left、right、top、bottom。
扩展区域或最终点击点越界时返回 INVALID_HITBOX，区域指纹覆盖完整命中区。

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

## 输入确认

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

inputAndWait 只发送一次输入，不自动重发。空条件时等待至少一个新 frameId；
成功后返回 session、inputFrameId、cursorBefore、observation 和 elapsedMs。
超时返回 WAIT_TIMEOUT，并标明 accepted:true 与 inputFrameId。

cursor 条件可组合 x、y、visible、style、blink，全部字段按 AND 匹配。
observe/compare 的 cursor 可设为 hide（默认）或 show；快照始终返回光标元数据。

```json
{
  "id": "SESSION_UUID",
  "options": {
    "baseline": "baseline.png",
    "region": { "x": 0, "y": 0, "width": 40, "height": 10 },
    "cursor": "hide",
    "pixelThreshold": 8, "maxDiffRatio": 0.001,
    "masks": [{ "x": 0, "y": 0, "width": 20, "height": 10 }]
  }
}
```

compare 的 region 为字符格，masks 为裁剪后 PNG 的像素。差异超限返回 pass:false、证据路径及非零 CLI 退出码。
