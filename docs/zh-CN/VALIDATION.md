# 验证

[English](../VALIDATION.md) · [简体中文](VALIDATION.md)

## 自动检查

```sh
npm run check
npm test
```

测试覆盖：

- Chrome/xterm 的 Unicode、样式、模式、查询响应与 PNG。
- 同步输出期间的观察边界，以及轻量状态读取。
- PTY 输出合批、背压、取消、最后输出和进程清理。
- 字符格定位、输入编码、区域稳定判断。
- 迟到/及时终端应答、跨分片查询、suppress 策略和应答 metrics。
- clickText 命中区、inputAndWait 单次输入确认、超时证据和光标条件。
- 真实 PTY 未提交帧点击、区域指纹保护、按页和首尾滚动编码。
- MCP 使用 `colorMode:"truecolor"` 启动，非法 colorMode 诊断包含收到的值。
- 光标可见性/样式/闪烁、截图默认隐藏，以及 resize 后 PNG 网格尺寸。
- CLI 与 MCP 的会话、图片返回及断开清理。
- 并发启动、状态发布失败及服务重启。

测试使用仓库内的独立夹具，不需要外部应用或模型服务。

## 视觉检查

引擎测试将截图输出到 `artifacts/engine/`。查看中文、emoji、空白盲文、
前景背景、字重和行列尺寸；文字断言不能替代视觉检查。

## 性能

运行方式和测量边界见 [PERFORMANCE.md](PERFORMANCE.md)。
基准输出保存在忽略目录 `artifacts/`，不作为通用性能承诺。

## 平台限制

Windows `node-pty 1.1.0` 在自然退出后的资源清理中可能由辅助进程输出
`AttachConsole failed`。必须核实进程最终释放，并保留原始诊断。
测试成功不能替代各终端宿主、字体和输入法配置下的验收。
