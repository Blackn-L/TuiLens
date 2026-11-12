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

同步输出始终不提交时，`clickText` 还支持 `options.allowPendingFrame:true`。
这是显式读取未提交字符缓冲的逃生口，不保证 PNG 稳定；点击前仍重新校验目标区域指纹。
帧保护、普通观察和截图行为不变。

## 滚动导航

```json
{ "type": "scroll", "x": 20, "y": 10, "direction": "down", "unit": "page", "amount": 5 }
{ "type": "scroll", "x": 20, "y": 10, "to": "top" }
```

`unit:"page"` 将每页展开为当前终端行数。展开前的 `amount` 范围为 1～100。
`to:"top"`/`"bottom"` 在指定位置发送有界向上/向下滚轮事件序列，不能与 direction、unit、amount 同用。
这是应用级导航请求，不是历史绝对行号寻址。应用须启用字符格 SGR 鼠标上报；
应用的回滚容量和每次事件滚动行数仍生效。需要拖滚动条时用 drag，应用支持按键时也可用 Home、End、PageUp、PageDown。

`to:"top"`/`"bottom"` 会拆成 20 批、每批 100 个事件写入 PTY，批次之间让出事件循环。
事件总数不变，但不再是一次 20 KB 的突发写入，并且操作可以中途取消。
普通滚轮滚动仍是单次写入。

## 回滚区

```json
{ "id": "SESSION_UUID", "screenshot": false, "scrollback": 200 }
```

在 `snapshot.scrollback` 中返回视口上方的行，从旧到新，只包含文本（不含字符格）。
行数范围 1～5000；实际可用行数少于请求时 `scrollbackTruncated` 为 `true`。
适用于把历史交给终端回滚区、而不是在备用屏幕中重绘的应用。

## 终端能力画像

```json
{
  "command": "node",
  "args": ["app.mjs"],
  "renderer": "webgl",
  "terminalProfile": "kitty",
  "graphics": { "sixel": false, "kitty": true, "iterm": false }
}
```

`terminalProfile` 接受内置 preset 键/名称或 JSON profile 路径。返回的会话通过 `terminalProfile`
给出解析后的名称。`graphics` 按单项覆盖图片协议；旧 `images` 仍兼容，但映射到相同能力。
详见[终端能力画像](PROFILES.md)。

`renderer` 选择 `dom`（默认）或 `webgl`。返回的会话通过 `renderer` 给出实际值；WebGL 启动失败会回退
DOM 并返回 `dom`。实际 renderer 还会写入录制头、scenario/perf 环境、观察元数据和视觉比较 JSON。
WebGL 可能使用整数格宽，截图尺寸会变化；切换后需要重新录制视觉基准。

## 键盘协议

`modes.keyboard` 反映应用协商到的键盘协议：

```json
{ "kitty": 1, "modifyOtherKeys": 2 }
```

- `kitty` 为 Kitty keyboard protocol 标志位（`CSI > flags u` 压栈、`CSI < n u` 弹栈、`CSI = flags ; mode u` 更新）。
  非零时带修饰的按键编码为 `CSI code ; modifier u`，例如 `Shift+Enter` 为 `\x1b[13;2u`。
- `modifyOtherKeys` 为 xterm XTMODKEYS 级别。级别 2 时，传统编码无法表达的
  `Shift+Enter`、`Ctrl+Space` 使用 `CSI 27 ; modifier ; code ~`。
- `Ctrl+字母` 即使在 `modifyOtherKeys` 下也保留传统 C0 字节（`Ctrl+a` → `\x01`），因为应用依赖这些字节。
- 未协商任何协议时，`Shift+Enter`、`Ctrl+Space` 会返回 `UNSUPPORTED_KEY`，而不是静默发送一个 `\r`。

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
启用截图时使用独立的有界采集预算，等待成功不会因截图超时而变成无法判断输入是否送达的失败。

cursor 条件可组合 x、y、visible、style、blink，全部字段按 AND 匹配。
observe/compare 的 cursor 可设为 hide（默认）或 show；快照始终返回光标元数据。

## 自动终端应答

`protocolReplies.mode:"auto"` 只放行在 `maxLatencyMs`（默认 250）内匹配查询的已知应答。
`"forward"` 不过滤；`"suppress"` 丢弃完整 DA1/DA2、CPR/DSR 等已知应答。
suppress 保留无关输入，不再吞掉所有 PTY 输入。过滤针对渲染器应答分片；
应用在 cooked/echo 模式查询时，仍应优先修正应用 TTY 模式，或使用应用探测开关及启动时的 suppress。
可通过 metrics 查看转发/丢弃计数。suppress 不能替代应用正确的 TTY 模式处理。

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
