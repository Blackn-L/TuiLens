# TuiLens

[![npm 版本](https://img.shields.io/npm/v/tuilens)](https://www.npmjs.com/package/tuilens)
[![支持的 Node.js 版本](https://img.shields.io/node/v/tuilens)](https://github.com/Blackn-L/TuiLens/blob/main/package.json)
[![main 分支构建与测试](https://github.com/Blackn-L/TuiLens/actions/workflows/checks.yml/badge.svg?branch=main&event=push)](https://github.com/Blackn-L/TuiLens/actions/workflows/checks.yml?query=branch%3Amain)
[![许可证](https://img.shields.io/npm/l/tuilens)](https://github.com/Blackn-L/TuiLens/blob/main/LICENSE)

**面向 AI Agent 和测试的终端自动化工具。** 在真实伪终端（PTY）里启动交互程序，发送按键或鼠标操作，读取程序绘制的画面。读取文字无需浏览器。需要检查用户看到的布局、颜色或图形时，可以截取 PNG。

[English](README.md) · [中文文档](https://blackn-l.github.io/TuiLens/zh-CN/)

<img src="docs/assets/agent-demo.png" width="640" alt="终端先显示 READY，收到 g 后显示 UPDATED。帧差异记录了 UPDATED 所在的行，索引为 7。">

[演示程序](https://github.com/Blackn-L/TuiLens/blob/main/examples/echo-tui.mjs) 启动时显示 `READY`，收到 `g` 后在另一行写出 `UPDATED`。[示例场景](https://github.com/Blackn-L/TuiLens/blob/main/examples/scenario.json) 还会执行一次拖动并截取结果。[打开示例报告 →](https://blackn-l.github.io/TuiLens/examples/scenario.html)

## 在自己的终端试一下

安装 Node.js 22 或更高版本后，运行以下命令。在任意目录都能启动 Node 交互提示符。

```sh
npm install -g tuilens
tuilens launch --cols 64 --rows 8 "--" node -i
```

复制启动结果中的 `data.id`，替换下面的 `SESSION_ID`。

```sh
tuilens wait SESSION_ID --text "Welcome to Node.js"
tuilens type SESSION_ID "6 * 7"
tuilens key SESSION_ID Enter
tuilens wait SESSION_ID --text 42
tuilens observe SESSION_ID
tuilens close SESSION_ID
```

观察结果会显示输入的算式，以及 Node 在下一行给出的答案 `42`。[安装说明与 shell 示例](docs/zh-CN/GETTING-STARTED.md#cli)

## 选择使用方式

| 想做什么 | 从这里开始 |
| --- | --- |
| 让 AI Agent 读取并操作终端 | [连接 MCP 客户端](https://blackn-l.github.io/TuiLens/zh-CN/GETTING-STARTED.html#mcp) |
| 在 shell 或 CI 中复现交互 | [使用 JSON CLI](https://blackn-l.github.io/TuiLens/zh-CN/GETTING-STARTED.html#cli) |
| 用 JavaScript 或 TypeScript 写断言 | [导入 SDK](https://blackn-l.github.io/TuiLens/zh-CN/GETTING-STARTED.html#sdk) |

## 可以测什么

- **交互行为。** 按区域或样式定位文字，发送一次操作，等待画面出现预期结果。帧差异可以指出具体哪些行发生了变化。[输入、定位与等待](docs/zh-CN/PROTOCOL.md)
- **渲染效果。** 按字符格截取区域，和已确认的基准图逐像素比较。终端配置可启用 SIXEL、iTerm2 内联图片或已支持的 Kitty 图形协议子集。[视觉比较](docs/zh-CN/VISUAL.md) · [图片支持](docs/zh-CN/IMAGES.md) · [终端能力配置](docs/zh-CN/PROFILES.md)
- **回归。** 回放录制的终端输出，把一组操作写成可重复运行的场景，或分轮测量从发送输入到出现结果的延迟。场景和性能测试可输出 JUnit XML 与离线 HTML 报告。[录制与场景](docs/zh-CN/RECORDING.md) · [性能测试](docs/zh-CN/PERFORMANCE.md) · [证据报告](docs/zh-CN/REPORTING.md)

> **状态：** 0.6.1 实验版本。支持 Windows 和 Linux，macOS 支持处于实验阶段。截图与视觉比较需要 Chrome、Edge 或 Chromium。

[贡献指南](docs/zh-CN/CONTRIBUTING.md) · [安全问题](SECURITY.md) · [MIT 许可证](LICENSE) · [第三方许可证](THIRD_PARTY.md)
