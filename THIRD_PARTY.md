# 第三方组件

直接运行依赖：

| 包 | 版本 | 用途 | 上游许可证 |
| --- | --- | --- | --- |
| node-pty | 1.1.0 | PTY / ConPTY 进程通道 | MIT |
| @xterm/xterm | 6.0.0 | 终端状态与绘制 | MIT |
| @xterm/addon-unicode-graphemes | 0.4.0 | 字素与宽字符处理 | MIT |
| playwright | 1.65.0 | 浏览器生命周期与截图 | Apache-2.0 |
| @modelcontextprotocol/sdk | 1.32.2 | MCP stdio 协议 | MIT |
| zod | 4.6.7 | 接口参数校验 | MIT |

精确传递依赖及完整性校验见 `package-lock.json`；分发时保留各包自带许可证。
Chrome/Chromium 为外部运行环境，TuiLens 仓库不包含浏览器或系统字体。
项目尚未确定分发许可证；当前 package 设置为 private，防止意外发布到包注册表。
