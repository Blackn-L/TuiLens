# Third-party components / 第三方组件

Direct runtime dependencies / 直接运行依赖：

| 包 | 版本 | 用途 | 上游许可证 |
| --- | --- | --- | --- |
| node-pty | 1.1.0 | PTY / ConPTY 进程通道 | MIT |
| @xterm/xterm | 6.0.0 | 终端状态与绘制 | MIT |
| @xterm/addon-unicode-graphemes | 0.4.0 | 字素与宽字符处理 | MIT |
| @xterm/addon-image | 0.9.0 | SIXEL rendering / 图像渲染 | MIT |
| @xterm/addon-webgl | 0.19.0 | Optional WebGL renderer / 可选 WebGL 绘制 | MIT |
| pngjs | 7.0.0 | PNG decoding and comparison / PNG 解码和比较 | MIT |
| playwright | 1.65.0 | 浏览器生命周期与截图 | Apache-2.0 |
| @modelcontextprotocol/sdk | 1.32.2 | MCP stdio 协议 | MIT |
| zod | 4.6.7 | 接口参数校验 | MIT |

Exact transitive versions and integrity hashes are recorded in `package-lock.json`.
Preserve each dependency's license when distributing it. Chrome/Chromium and system fonts are external runtime dependencies.
The protocol diacritic table is standard Unicode/Kitty protocol data; the source is attributed in its module.
TuiLens is released under the [MIT License](LICENSE). Third-party components retain their own licenses.

传递依赖版本和校验值见锁文件，分发时保留各包许可证。浏览器与系统字体属于外部运行环境。
组合符表为协议标准数据，模块中保留来源。TuiLens 采用 [MIT 许可证](LICENSE) 开源；
各第三方组件仍保留上游许可证。
