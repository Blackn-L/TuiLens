# Getting started

[English](GETTING-STARTED.md) · [简体中文](zh-CN/GETTING-STARTED.md)

Use [MCP](#mcp) to give an agent a terminal, the [CLI](#cli) to drive one from a shell, or the [SDK](#sdk) to write tests. Each example below uses the interactive Node.js prompt, so you can try it in any directory with Node.js 22 or newer.

## MCP

Generate the configuration for your client. This example prints TOML for Codex and uses npm to start the server on demand.

```sh
npx -y tuilens mcp-config --client codex --mode npx
```

Add the generated configuration to Codex's `~/.codex/config.toml` (on Windows, `%USERPROFILE%\.codex\config.toml`). Restart the client and ask the agent:

> Use TuiLens to launch `node` with arguments `["-i"]`. Wait for “Welcome to Node.js”, type `6 * 7`, and press Enter. Read back the line with Node's answer and close the session.

You should see the agent return `42`. An MCP launch result has an `id`, and an observation includes `snapshot.lines` and `snapshot.frameId`. An agent can save that frame ID, send an action with `terminal_inputAndWait`, then request a diff from the saved frame. Screenshot capture is opt-in.

Use `--client claude-code`, `cursor`, `gemini`, or `json` for other clients. If a desktop client cannot find the executable on its `PATH`, install globally and generate a configuration with `--mode absolute`. [Client configuration, resources and troubleshooting](MCP-SETUP.md)

## CLI

Install the command globally and check the local runtime.

```sh
npm install -g tuilens
tuilens doctor
```

Start an interactive Node prompt and save the session ID in your shell. Quoting `"--"` also passes the separator through npm's PowerShell launcher.

**PowerShell**

```powershell
$sessionId = (tuilens launch --cols 64 --rows 8 "--" node -i | ConvertFrom-Json).data.id
```

**Bash or Zsh**

```sh
sessionId=$(tuilens launch --cols 64 --rows 8 "--" node -i | node -p "JSON.parse(require('node:fs').readFileSync(0, 'utf8')).data.id")
```

Run the following in the same shell. The two waits confirm that the REPL is ready for input and that it has drawn the result.

```sh
tuilens wait "$sessionId" --text "Welcome to Node.js"
tuilens type "$sessionId" "6 * 7"
tuilens key "$sessionId" Enter
tuilens wait "$sessionId" --text 42
tuilens observe "$sessionId"
tuilens close "$sessionId"
```

Look in `data.snapshot.lines` in the observation. Among the lines you should find:

```text
> 6 * 7
42
```

To capture a PNG, add `--screenshot` to the observe command before closing the session. Its path is in `data.screenshot.path`. Text and screenshot share a frame ID. Crops use zero-based character cells, and visual comparison masks use pixels within the cropped PNG.

For an application that reacts to each keystroke, `input-wait` sends the text once and waits for a visible response. Use separate `type` and `key` calls when the application expects an Enter key to submit a line. Run `tuilens --help` for positional commands or pass structured arguments with `--json`, `--file` or `--stdin`. [Input guards, waits and observation formats](PROTOCOL.md)

## SDK

Install TuiLens as a dependency of your test project.

```sh
npm install --save-dev tuilens
```

Save the following as `terminal.test.mjs`. The same package exports TypeScript declarations.

```js
import test from "node:test";
import { SessionManager, terminal } from "tuilens";

test("Node evaluates an expression in the terminal", async () => {
  const manager = new SessionManager({ artifactDir: "./artifacts" });
  try {
    const tui = await terminal(manager, {
      command: process.execPath,
      args: ["-i"],
      cols: 64,
      rows: 8,
    });
    await tui.expectText("Welcome to Node.js");
    await tui.type("6 * 7");
    await tui.key("Enter");
    await tui.expectText("42");
  } finally {
    await manager.closeAll();
  }
});
```

```sh
node --test terminal.test.mjs
```

The test passes when the expected text appears on screen. For a negative assertion, `expectNoText("Error", { timeoutMs: 500 })` observes for the full interval. Assertion failures include expected and actual values, plus a screen excerpt and screenshot path when available. Use `tui.screen()` for text and cursor state, `tui.screenshot()` for a PNG, or `manager.observe(tui.id, { view: "cells" })` for the character grid.

## Reproduce the example report

The [scenario report](https://blackn-l.github.io/TuiLens/examples/scenario.html) shows a run of the bundled repository example. To run it locally, clone the repository so the scenario and its target application are present.

```sh
git clone https://github.com/Blackn-L/TuiLens.git
cd TuiLens
npm ci
npm run build
node dist/src/interfaces/cli.js scenario --file examples/scenario.json --html scenario.html
```

Open `scenario.html` to inspect the steps and screenshots. Add `--junit scenario.xml` for CI. Run the same CLI with `perf --file examples/perf.json --html perf.html` for the example performance workload. [Scenario source](https://github.com/Blackn-L/TuiLens/blob/main/examples/scenario.json) · [Recordings](RECORDING.md) · [Performance measurement](PERFORMANCE.md) · [Report formats](REPORTING.md)

## Installation and diagnostics

| Situation | What to do |
| --- | --- |
| One-off command | Use `npx -y tuilens doctor`. |
| pnpm 10+ blocked `node-pty` | For a global install, use `pnpm add -g tuilens` and `pnpm approve-builds -g`, then select `node-pty`. In a local project, approve the build there. |
| npm 12+ in a project | Add `"allowScripts": { "node-pty@1.2.0-beta.18": true }` to the consuming project's root `package.json` before installing. If no prebuilt native binary is available, install the platform C++ build tools. |
| Need screenshots, image protocols or visual comparisons | TuiLens looks for Chrome, Edge or Chromium. Set `TUILENS_BROWSER_PATH` to select an executable, or use `npx playwright-core install chromium` if no compatible browser is installed. |
| Check setup | `tuilens doctor` checks Node, native module loading, browser discovery, storage and daemon metadata. It exits with code 1 on an error. The CLI exercise above also tests a real PTY. |
| Check fonts | `tuilens probe` renders fixed glyphs and reports the font/grid fingerprint. Use `TUILENS_FONT_FILE` to pin a font and `TUILENS_FONT_FAMILY` for fallbacks. Restart the daemon after changing capture fonts. [Font and baseline settings](VISUAL.md) |

The CLI and MCP use a local daemon. `close` releases one session. `shutdown` closes every session on that daemon. To isolate a run, set `TUILENS_HOME` in the launching environment (default `~/.tuilens`). `TUILENS_IPC_TIMEOUT_MS` optionally bounds IPC waits. [Session lifecycle and limits](ARCHITECTURE.md)

Messages default to English. For Simplified Chinese, use `$env:TUILENS_LANG = "zh-CN"` in PowerShell or `export TUILENS_LANG=zh-CN` in Bash or Zsh. Set it in the MCP client's environment for localized tool descriptions. Structured errors expose `messageEn` and `messageZh`, with `message` in the active language.
