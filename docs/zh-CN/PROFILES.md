# 终端能力画像

[English](../PROFILES.md) · [简体中文](PROFILES.md)

终端 profile 把被模拟的终端身份变成显式数据。一个 profile 声明会话使用的环境变量、自动应答、
图片协议、键盘能力元数据和回滚缓冲。启动器不再硬编码 `TERM=xterm-256color`。

## 内置 preset

`terminalProfile` / `--terminal-profile` 接受 preset 键，也接受表中显示的名称。版本范围表示参考范围，
TuiLens 不检测宿主终端版本。
启动参数中的 profile 路径从 `launch.cwd`（或进程工作目录）解析；`extends` 路径从声明它的
profile 文件所在目录解析。

| Preset | 参考范围 | `TERM` | 图片 | 键盘 |
| --- | --- | --- | --- | --- |
| `kitty` | `>=0.36 <1` | `xterm-kitty` | Kitty | Kitty + `modifyOtherKeys` |
| `wezterm` | `>=20230712 <2026` | `xterm-256color` | SIXEL + iTerm2 + Kitty | Kitty + `modifyOtherKeys` |
| `iterm2` | `>=3.4 <4` | `xterm-256color` | SIXEL + iTerm2 | `modifyOtherKeys` |
| `windows-terminal` | `>=1.18 <2` | `xterm-256color` | 无 | `modifyOtherKeys` |
| `alacritty` | `>=0.12 <1` | `alacritty` | 无 | Kitty + `modifyOtherKeys` |
| `vscode` | `>=1.85 <2` | `xterm-256color` | 无 | `modifyOtherKeys` |
| `tmux` | `>=3.2 <4` | `screen-256color` | Kitty | Kitty + `modifyOtherKeys` |
| `xterm-256color` | `>=276 <400` | `xterm-256color` | 无 | `modifyOtherKeys` |
| `linux` | `>=5 <7` | `linux` | 无 | 无 |

默认使用 `xterm-256color`。内置 preset 是保守的参考声明，不表示该终端的每个构建都支持全部能力。

## profile 模型

```json
{
  "name": "kitty-0.40",
  "versionRange": ">=0.36 <1",
  "env": {
    "TERM": "xterm-kitty",
    "TERM_PROGRAM": "kitty",
    "TERM_PROGRAM_VERSION": "0.40.0",
    "COLORTERM": "truecolor"
  },
  "replies": {
    "da1": "\u001b[?62;22c",
    "da2": "\u001b[>0;4000;1c",
    "xtversion": "\u001bP>|kitty(0.40.0)\u001b\\"
  },
  "capabilities": {
    "color": "truecolor",
    "keyboard": { "kitty": 1, "modifyOtherKeys": 2 },
    "mouse": ["1000", "1002", "1003", "1006", "1016"],
    "graphics": { "sixel": false, "kitty": true, "iterm": false },
    "underlineStyles": ["single", "double", "curly"],
    "synchronizedOutput": true,
    "focusEvents": true,
    "hyperlink": true,
    "unicodeVersion": "15.1",
    "scrollback": 2000
  }
}
```

带 `extends` 的文件中，除 `name` 外所有顶层字段都可省略。未知字段会被拒绝。
`capabilities.scrollback` 接受 0～5000 行，默认 2000。

## 应答与能力

- `CSI c` 返回 `replies.da1`。
- `CSI > c` 返回 `replies.da2`。
- `CSI > q` 返回 `replies.xtversion`。
- `CSI ? u` 在声明 `capabilities.keyboard.kitty` 时返回 `CSI ? <flags> u`。
- 省略 `replies.da1` 时，根据 `capabilities.color` 与 `capabilities.graphics.sixel` 合成。
- 显式 DA1 的 feature `4` 会与 `capabilities.graphics.sixel` 保持一致。
- 省略 `da2` 或 `xtversion` 时不返回该应答；空字符串也表示抑制。
- `modifyOtherKeys` 是能力元数据并参与已协商输入的编码；TuiLens 不合成 XTQMODKEYS 查询应答。
- `mouse`、`underlineStyles`、`synchronizedOutput`、`focusEvents`、`hyperlink` 和 `unicodeVersion`
  当前用于声明、矩阵比较和后续查询处理；不会直接改变渲染器的鼠标跟踪、下划线绘制或 Unicode 表。

Windows 系统 ConPTY 会在浏览器模拟器看到查询之前自行回答 DA1/DA2。因此显式选择 profile
（或覆盖 `graphics`/`images`）的会话使用 node-pty 随包提供的 ConPTY DLL；未显式指定 profile 的默认
快速路径继续使用系统 ConPTY。TuiLens 还会在 `ManagedSession.protocolResponse` 进入 PTY 前按 profile
改写终端来源的 DA1/DA2/XTVERSION/Kitty 应答。

## 派生 profile

`extends` 接受 preset 键/名称或另一个 JSON 文件。对象递归合并，数组替换继承值。派生文件只写差异：

```json
{
  "name": "kitty-sixel",
  "extends": "kitty",
  "env": { "TERM_PROGRAM_VERSION": "0.40.1-custom" },
  "capabilities": {
    "graphics": { "sixel": true },
    "keyboard": { "kitty": 3 },
    "scrollback": 4000
  }
}
```

这个 profile 保留 Kitty 的其他环境与能力；DA1 增加 feature `4`，Kitty 查询返回标志位 `3`。
相对文件路径从声明 `extends` 的文件所在目录解析。循环、缺失文件、非法 JSON 和超过 16 层的继承都会报错；
profile 文件最大 256 KiB。

## 启动

```sh
tuilens launch --terminal-profile kitty -- node app.mjs
tuilens launch --terminal-profile ./profiles/kitty-sixel.json -- node app.mjs
```

SDK：

```ts
const session = await manager.launch({
  command: "node",
  args: ["app.mjs"],
  terminalProfile: "wezterm",
});

const profile = await resolveTerminalProfile("./profiles/kitty-sixel.json");
const presets = listTerminalProfiles();
```

覆盖顺序：

1. 内置/默认 profile。
2. 文件中的 `extends` 链。
3. `launch.graphics` 按单项覆盖图片协议。
4. 已弃用的 `launch.images` 在出现时整体覆盖图片协议。
5. `launch.env` 覆盖 profile 环境变量。
6. `colorMode` 最后作用于颜色环境变量和 `capabilities.color`。

会话结果通过 `terminalProfile` 返回解析后的 profile 名称。

## 场景与性能矩阵

场景和性能规格都支持最多 32 个不重复的 `profiles`，同一工作负载按顺序在每个 profile 下运行。

```json
{
  "version": 1,
  "launch": { "command": "node", "args": ["app.mjs"] },
  "profiles": ["kitty", "wezterm", "xterm-256color"],
  "steps": [{ "type": "wait", "conditions": [{ "kind": "text", "text": "READY" }] }]
}
```

场景矩阵返回 `matrix: true`，每个 profile 在 `runs` 中有一份独立报告和解析后的 `terminalProfile`。
性能矩阵返回 `matrix: true`、按 profile 分组的 `runs`，以及包含每个指标 p50/p95/稳定性 的 `table`。
基线文件只能用于单 profile；多 profile 矩阵会拒绝共享基线，避免悄悄比较不同终端。
某个 profile 无法启动或没有有效测量时，会生成 `reportPath: null` 的失败项，不会丢弃其他 profile
已经完成的结果。

录制保存最终解析出的渲染能力和应答，不保存环境变量或 profile 文件路径；回放不依赖外部 JSON
profile 仍然存在。只有 `images` 的旧录制保持原有回放行为。

`examples/profile-matrix.json` 会用最小 DA1/DA2/XTVERSION/Kitty 探针运行全部内置 preset。

## 已弃用的 `images`

`images` 仍为兼容保留，内部映射到 `capabilities.graphics`：

| `images` | SIXEL | Kitty | iTerm2 |
| --- | --- | --- | --- |
| `off` | false | false | false |
| `sixel` | true | false | false |
| `iterm` | false | false | true |
| `all` | true | true | true |

新代码使用正交覆盖：

```json
{ "graphics": { "sixel": true, "kitty": false, "iterm": false } }
```

profile、CLI/MCP schema 和 TypeScript SDK 共用同一模型。
