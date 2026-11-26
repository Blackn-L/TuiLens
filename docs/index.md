---
layout: page
sidebar: false
title: Terminal automation for AI agents
headline: Give your agent a terminal it can see and control.
summary: Run a real terminal application, send input, and inspect exactly which rows or pixels changed.
start: Get started
report: Open sample report
screenshotAlt: The terminal shows READY before pressing g and UPDATED afterward. The frame diff identifies the changed row.
caption: Pressing g changes one row in the example terminal.
interfaces: Choose an interface
routes:
  - id: mcp
    name: MCP
    description: Connect your AI agent to a local terminal.
  - id: cli
    name: CLI
    description: Run a scenario from your shell or CI job.
  - id: sdk
    name: TypeScript SDK
    description: Assert terminal behavior in your test suite.
---

<script setup>
import Landing from './.vitepress/theme/Landing.vue'
</script>

<Landing />
