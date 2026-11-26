---
layout: page
sidebar: false
title: 面向 AI Agent 的终端自动化
headline: 让 AI Agent 看懂并操作终端
summary: 运行真实的终端应用，发送按键或鼠标输入，查看哪些行或像素发生了变化。
start: 快速开始
report: 打开示例报告
screenshotAlt: 终端截图先显示 READY，按下 g 后显示 UPDATED，帧差异标明了发生变化的行。
caption: 在示例终端按下 g，只有一行文字发生变化。
interfaces: 选择接入方式
routes:
  - id: mcp
    name: MCP
    description: 将 AI Agent 接入本机终端。
  - id: cli
    name: CLI
    description: 在 Shell 或 CI 中运行测试场景。
  - id: sdk
    name: TypeScript SDK
    description: 在测试代码中断言终端行为。
---

<script setup>
import Landing from '../.vitepress/theme/Landing.vue'
</script>

<Landing />
