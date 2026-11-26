# MCP client setup

[English](MCP-SETUP.md) · [简体中文](zh-CN/MCP-SETUP.md)

TuiLens exposes terminal automation through an MCP stdio server. The MCP client starts `tuilens mcp`
as a child process; there is no URL or port to connect to. Install TuiLens on the machine where the
terminal sessions should run.

## Requirements

- Node.js 22 or newer.
- Windows, Linux, or macOS (experimental).
- **Text-only sessions need no browser.**
- Screenshots, image protocols and visual comparisons need Chrome, Edge or Chromium. Install Playwright
  Chromium only when no system browser is available:

  ```sh
  npx playwright-core install chromium
  ```

- Platform C++ build tools if `node-pty` cannot use a prebuilt binary.

## Install

For an existing Windows global install, [stop the daemon before upgrading](GETTING-STARTED.md#windows-global-upgrades). For a first global install, run the following commands.

```sh
npm install -g tuilens
tuilens doctor
```

Or run without a global install:

```sh
npx -y tuilens doctor
npx -y tuilens mcp
```

With pnpm 10+, approve the native `node-pty` build after installing:

```sh
pnpm add -g tuilens
pnpm approve-builds -g
```

Select `node-pty` in the prompt. In a project that depends on TuiLens, run `pnpm approve-builds` in
that project instead.

`tuilens doctor` checks Node.js, platform support, browser discovery, `node-pty`, storage permissions
and daemon state without starting a daemon. Exit code 1 means an error-level check failed.

## Generate the client configuration

Do not hand-write command paths if `mcp-config` can produce them:

```sh
tuilens mcp-config --client codex
tuilens mcp-config --client claude-code
tuilens mcp-config --client cursor
tuilens mcp-config --client gemini
tuilens mcp-config --client json
```

Modes:

- `--mode global` (default): command `tuilens`, args `["mcp"]`. Use after a global install.
- `--mode npx`: command `npx`, args `["-y", "tuilens", "mcp"]`. No global install required.
- `--mode absolute`: prints `process.execPath` and the installed `cli.js` absolute path. Use this for
  Cursor, Claude Desktop and other GUI clients that do not inherit the shell `PATH`.

Example:

```sh
tuilens mcp-config --client codex --mode global
tuilens mcp-config --client json --mode absolute
```

## Client setup

### Codex

```sh
tuilens mcp-config --client codex
```

Put the TOML output in `%USERPROFILE%\.codex\config.toml` on Windows or `~/.codex/config.toml` on
Linux/macOS:

```toml
[mcp_servers.tuilens]
command = "tuilens"
args = ["mcp"]
```

For a GUI or sandboxed Codex process that cannot find `tuilens`, use:

```sh
tuilens mcp-config --client codex --mode absolute
```

Restart Codex after changing the file.

### Claude Code

```sh
tuilens mcp-config --client claude-code
```

The command form is:

```sh
claude mcp add --scope user tuilens -- tuilens mcp
```

Use `--mode npx` or `--mode absolute` to generate the corresponding command. Restart Claude Code or
start a new session after adding the server.

### Cursor

```sh
tuilens mcp-config --client cursor
```

Paste the JSON into `~/.cursor/mcp.json`, or into `.cursor/mcp.json` for a project-scoped server:

```json
{
  "mcpServers": {
    "tuilens": {
      "command": "tuilens",
      "args": ["mcp"]
    }
  }
}
```

Cursor is a GUI client. If it reports `spawn tuilens ENOENT`, regenerate with
`--mode absolute`.

### Gemini CLI

```sh
tuilens mcp-config --client gemini
```

Paste the `mcpServers` JSON into `~/.gemini/settings.json` (user scope) or
`.gemini/settings.json` (project scope). The same configuration shape also works for clients that
accept the common `mcpServers` object.

### Other clients

```sh
tuilens mcp-config --client json
```

Keep `command` and `args` unchanged; only the surrounding file location differs by client.

## Recommended agent loop

The MCP initialization instructions and tool descriptions tell agents to use:

```text
terminal_launch
  -> terminal_observe(view:"compact")       # remember snapshot.frameId
  -> terminal_inputAndWait                  # send once and wait for evidence
  -> terminal_observe(view:"diff",
       fromFrameId:<previous frameId>)      # only changes and metadata
  -> terminal_close
```

Pass `screenshot:true` only for an explicit visual check. Use `terminal_scenario` for repeatable flows
and `terminal_perf` for latency or memory measurements. A normal shell remains the right choice for
simple non-interactive commands.

## Resources and prompts

The server exposes read-only resources:

| URI | Content |
| --- | --- |
| `tuilens://sessions` | Metadata for sessions owned by this MCP instance. |
| `tuilens://sessions/{id}/screen` | Compact text screen, browser-free. |
| `tuilens://sessions/{id}/screenshot` | Current PNG, 32 MiB cap. |
| `tuilens://sessions/{id}/metrics` | Backpressure, queue and protocol-reply counters. |
| `tuilens://artifacts/{name}` | Report, diff image, screenshot or recording; 16 MiB cap. |

Artifact names are relative to `TUILENS_HOME/artifacts`. Absolute paths, `..`, NUL bytes and symlink
escapes are rejected after both `resolve` and `realpath` containment checks.

Prompts:

- `tui_reproduce_bug`
- `tui_visual_regression`

Prompt text and descriptions follow `TUILENS_LANG` (`en` by default, `zh-CN` for Chinese).

## Progress and cancellation

When the client supplies `_meta.progressToken`, TuiLens forwards real server progress for `wait`,
`inputAndWait`, `replay`, `scenario` and `perf`. Notifications include `progress` and `total`;
there is no fixed heartbeat. Cancelling the MCP request aborts the matching daemon operation.

## Verify the connection

After restarting the client:

1. Confirm the tools appear, including `terminal_launch`, `terminal_observe`,
   `terminal_inputAndWait`, `terminal_wait`, `terminal_compare`, `terminal_scenario`,
   `terminal_perf` and `terminal_close`.
2. Call `terminal_launch` with this small Node.js program:

   ```json
   {
     "command": "node",
     "args": ["-e", "process.stdout.write('READY\\n');setInterval(()=>{},1000)"],
     "cols": 80,
     "rows": 16
   }
   ```

3. Copy the `id` in the launch result. Use it in `terminal_wait` to give the program time to draw:

   ```json
   { "id": "<session-id>", "conditions": [{ "kind": "text", "text": "READY" }] }
   ```

4. Call `terminal_observe` with `{"id":"<session-id>"}`. A working connection returns
   `READY` in `snapshot.lines[0]`. Call `terminal_close` with the same ID to end the session.

Text observation works without a browser. A screenshot request activates Chromium and reports the
live `renderer`; if no browser is installed, the screenshot fails while text observation remains
available.

## Multi-agent use

Each MCP stdio instance owns the sessions it launches or adopts. Its identity survives idle IPC
reconnections. Agents sharing a single MCP instance also share its sessions. `terminal_list` and
`tuilens://sessions` show the current owner's sessions. Use `terminal_list` with `{"includeAll":true}`
for a daemon-wide inventory. Operating on a session held by another owner returns `SESSION_NOT_OWNED`.

To hand off a running session, finish pending operations, then:

1. The current owner calls `terminal_handoff` with the session ID and gives that ID and the returned
   token to the recipient. Issuing a replacement token invalidates the earlier one.
2. The recipient calls `terminal_adopt` with `{"id":"<session-id>","token":"<token>"}`. Successful
   adoption consumes the token and moves control and disconnect cleanup to the recipient.
   If adoption returns `SESSION_BUSY`, wait for the pending operation to finish and retry with the same token.
3. Keep the original MCP instance connected until adoption succeeds. A normal MCP disconnect
   closes the sessions that instance still owns. A forcibly killed adapter can leave sessions
   running. `tuilens list --all` shows their status. After other work on the daemon has finished,
   `tuilens shutdown` releases the remaining sessions.

CLI invocations share a separate owner, so scripts can continue a CLI session across commands.
Older MCP adapters use this same CLI scope. Upgrade each adapter to give it an independent owner.
Use `tuilens handoff <id>` to transfer from the CLI or `tuilens adopt --stdin` with the same JSON to
receive a session. Session ownership covers live terminal access. Files such as recordings and
screenshots in the shared artifacts directory retain the local user's filesystem permissions.

The default session budget is eight and can be changed with `TUILENS_MAX_SESSIONS`. When full, only
the oldest exited sessions are reclaimed; running sessions are never preempted.

## Troubleshooting

| Symptom | Likely cause | Action |
| --- | --- | --- |
| `spawn tuilens ENOENT` | GUI client does not inherit shell `PATH` | Use `tuilens mcp-config --client <client> --mode absolute` |
| `Cannot find module .../cli.js` | Absolute configuration points at a removed install | Reinstall TuiLens and regenerate with `--mode absolute` |
| npm reports `EBUSY` renaming the global `tuilens` directory on Windows | A running daemon may still hold the ConPTY files open | Finish active work, run `tuilens shutdown` and retry after the daemon exits. [Windows upgrade steps](GETTING-STARTED.md#windows-global-upgrades) |
| Scoped authentication fails after an upgrade | An older daemon is still running | Finish active work, run `tuilens shutdown`, then restart MCP clients with the updated binary. To run two versions side by side, use separate installations and `TUILENS_HOME` directories. |
| No tools after restart | Client did not reload MCP configuration | Restart the client or start a new session |
| `node-pty` install failure | pnpm/npm blocked the build script or C++ tools are missing | Approve `node-pty` with `pnpm approve-builds -g`, or install build tools |
| Browser launch failure | No Chrome/Edge/Chromium detected | Install a browser or run `npx playwright-core install chromium` |
| Relative command not found | Client working directory differs from the shell | Pass absolute `cwd` and program paths in tool arguments |
| `mcp` appears to hang | stdio server is waiting for JSON-RPC input | Test through an MCP client, not as an interactive command |
| Environment unclear | Runtime, PTY, storage or daemon state is invalid | Run `tuilens doctor` |

## Security

The MCP server can start arbitrary local programs with the permissions of the user running the MCP
client. Install only trusted packages and review scenario files before running them.

The transport is local: Windows uses a named pipe, Linux uses an abstract Unix socket, and macOS uses
a private Unix socket with a local token. There is no public HTTP/SSE control endpoint. Do not expose
the daemon socket to another machine.

See [protocol examples](PROTOCOL.md) for CLI and MCP argument shapes.
