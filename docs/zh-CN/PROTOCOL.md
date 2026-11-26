# 协议示例

[English](../PROTOCOL.md) · [简体中文](PROTOCOL.md)

CLI 使用 `--json`、`--file` 或 `--stdin`；MCP 接收相同对象。
会话 ID 来自 launch。除明确标注像素的字段外，坐标均为从 0 起算的字符格。

## 本机 IPC v2

守护进程只接受持久 NDJSON 连接。首帧用于连接级鉴权：

```json
{"type":"auth","version":2,"token":"<hex>"}
```

MCP 实例在鉴权帧的 `ownerId` 字段中附带私有 UUID，并要求 `auth_ok` 响应包含 `scoped: true`。在同一个 MCP 实例的生命周期内，
每次 IPC 重连都沿用该身份。CLI 连接省略该字段，共用独立的 CLI 会话范围。[会话归属与交接](MCP-SETUP.md#多-agent-协作)

成功返回 `auth_ok`（含 pid 与版本），失败返回 `auth_error` 后断开。默认握手超时为 15 秒。
鉴权后同一连接多路复用请求：

```json
{"type":"req","id":"<uuid>","method":"observe","params":{},"stream":true}
{"type":"cancel","id":"<uuid>"}
{"type":"event","id":"<uuid>","event":"frame","data":{}}
{"type":"res","id":"<uuid>","ok":true,"data":{}}
```

单行请求上限 1 MiB，单连接在途请求上限 64。取消按 id 精确生效，不影响其他请求。复用仍在途的
请求 ID 属于连接级协议错误，服务端会关闭连接且不会再发送第二个终态响应。`watch` 由服务端主动
推送 `frame`/`exit` 事件，CLI 不再轮询 `observe`；`wait`、`inputAndWait`、`scenario`、`perf`
和 `replay` 通过 `progress` 事件推送 `{kind,profile?,current,total,elapsedMs}`。进度经过节流，
且只来源于真实操作进度。`wait`、`inputAndWait` 和 `replay` 的 daemon 事件最多 100 条；
`scenario`/`perf` 按 step/round 上报，MCP 转发层会把单个工具调用的通知合并到最多 100 条。

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

CLI 相对路径以调用 shell 的工作目录为起点，MCP 相对路径以 stdio 服务进程的工作目录为起点。
此约定适用于启动参数 `cwd`、回放文件、视觉基线（含场景 compare 步骤）和性能基线文件。
省略 `cwd` 时，程序在该目录启动。终端 profile 的相对路径以启动目录为起点，程序参数原样传入。
CLI 的 `--cwd` 可覆盖规格文件中的 `launch.cwd`。

`terminalProfile` 接受内置 preset 键/名称或 JSON profile 路径。返回的会话通过 `terminalProfile`
给出解析后的名称。`graphics` 按单项覆盖图片协议。详见[终端能力画像](PROFILES.md)。

`renderer` 接受 `headless`（默认）、`dom` 或 `webgl`。`headless` 不加载 Chromium；显式
`dom`/`webgl`、启用图片协议，或首次截图/视觉比较会激活可视化层。返回会话始终反映实时状态，
因此可能从 `headless` 开始，之后变为 `dom`/`webgl`；`visualSyncDegraded: true` 表示懒加载时
有界回放窗口被截断。WebGL 启动失败会回退 DOM 并返回 `dom`。WebGL 可能使用整数格宽，
截图尺寸会变化；切换后需要重新录制视觉基准。

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
显式等待 `exited` 时，进程收到输入后即使没有继续输出，也可以用退出事件确认输入。
超时返回 WAIT_TIMEOUT，并标明 accepted:true 与 inputFrameId。
启用截图时使用独立的有界采集预算，等待成功不会因截图超时而变成无法判断输入是否送达的失败。

cursor 条件可组合 x、y、visible、style、blink，全部字段按 AND 匹配。
observe/compare 的 cursor 可设为 hide（默认）或 show；快照始终返回光标元数据。
`observe.view` 可取 `compact`、`full`、`cells` 或 `diff`，默认 `compact`。`compact` 裁剪行尾且省略
字符格，`full` 跳过 compact 行尾裁剪但不含字符格，`cells` 返回完整字符格。`diff` 必须提供 `fromFrameId`，
返回 `diff.changedLines`、`diff.changedRegion` 以及 resize/光标/模式差异，不重复整屏文本；超出
16 帧环缓存时降级为 compact 全文并设 `diff.fallbackFull:true`。所有视图都必须显式传
`screenshot:true` 才会截图。行内插入或删除导致显示宽度变化时，`changedRegion` 会覆盖被右移的
共同后缀直至较宽行的行尾。命中 diff 时仍保留调用方显式请求的 `scrollback`，否则快照省略
视口文本与字符格。区域文本/样式等待先在引擎侧判断，命中后才返回轻量观察。
内置引擎按终端实际字符格宽度定位 Unicode 差异。仅提供文本的自定义引擎遇到不确定字宽时，差异区域覆盖整条变化行。

## MCP 资源与 Prompt

MCP 客户端可发现以下只读资源：

| URI | MIME | 内容 |
| --- | --- | --- |
| `tuilens://sessions` | `application/json` | 当前 MCP 实例持有的会话元数据。 |
| `tuilens://sessions/{id}/screen` | `text/plain` | 无浏览器内核读取的 compact 画面。 |
| `tuilens://sessions/{id}/screenshot` | `image/png` | 按需截图，读取上限 32 MiB。 |
| `tuilens://sessions/{id}/metrics` | `application/json` | 背压与协议计数。 |
| `tuilens://artifacts/{name}` | 按后缀 | artifact 读取，上限 16 MiB，严格路径限制。 |

artifact 名称相对于 `TUILENS_HOME/artifacts`。绝对路径、`..`、NUL 字节和符号链接逃逸会在
`resolve` 与 `realpath` 检查后被拒绝。Prompt 为 `tui_reproduce_bug` 与
`tui_visual_regression`，其描述和正文跟随 `TUILENS_LANG`。

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
