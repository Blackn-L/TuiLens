# MCP client setup

[English](MCP-SETUP.md) · [简体中文](zh-CN/MCP-SETUP.md)

TuiLens exposes terminal automation through an MCP stdio server. The MCP client starts the
server as a child process; there is no URL or port to connect to. Each user runs TuiLens on
the machine where the terminal sessions should execute.

## Requirements

- Node.js 22 or newer and npm.
- Windows or Linux.
- Git, when installing from source.
- Google Chrome, Microsoft Edge, or Playwright Chromium.
- Platform C++ build tools if `node-pty` cannot use a prebuilt binary.

## Build the server

Version 0.4.0 is currently distributed from the repository, not from the npm registry.
`dist/` is generated and is not committed, so downloading a source archive is not enough.

```powershell
git clone https://github.com/Blackn-L/TuiLens.git
cd TuiLens
npm ci
npm run build
```

Install the browser only when no system browser is available:

```powershell
npx playwright install chromium
```

`TUILENS_BROWSER_PATH` can select a browser explicitly.

Run a launch/observe/close smoke test from the repository root before configuring the MCP
client:

```powershell
node .\dist\src\interfaces\cli.js launch --cols 80 --rows 16 -- node .\examples\echo-tui.mjs
node .\dist\src\interfaces\cli.js observe <session-id>
node .\dist\src\interfaces\cli.js close <session-id>
```

Replace `<session-id>` with `data.id` from the launch result. `observe` should return the
`READY` screen and a PNG path. Fix build or browser errors before debugging the MCP connection.

## Configure the client

Use the absolute path to the built CLI and pass `mcp` as the first argument. Do not point
the client at a directory or at a source `.ts` file.

### Codex

Edit `%USERPROFILE%\.codex\config.toml` on Windows (or `~/.codex/config.toml` on Linux):

```toml
[mcp_servers.tuilens]
command = "node"
args = ['C:\Users\<user>\TuiLens\dist\src\interfaces\cli.js', "mcp"]
```

On Linux:

```toml
[mcp_servers.tuilens]
command = "node"
args = ["/home/<user>/TuiLens/dist/src/interfaces/cli.js", "mcp"]
```

If a GUI client cannot find `node`, use its absolute path:

```powershell
(Get-Command node).Source
```

Set that path as `command`.

### Other MCP clients

For clients that accept the common `mcpServers` JSON shape:

```json
{
  "mcpServers": {
    "tuilens": {
      "command": "node",
      "args": [
        "C:\\Users\\<user>\\TuiLens\\dist\\src\\interfaces\\cli.js",
        "mcp"
      ]
    }
  }
}
```

The exact configuration file and restart procedure depend on the client; keep the same
command and arguments. If the client supports environment variables, `TUILENS_BROWSER_PATH`
can point to a specific browser executable.

## Verify the connection

After restarting the client, TuiLens should expose tools including `terminal_launch`,
`terminal_observe`, `terminal_find`, `terminal_input`, `terminal_inputAndWait`,
`terminal_wait`, `terminal_clickText`, `terminal_compare`, `terminal_replay`,
`terminal_scenario`, `terminal_perf`, and `terminal_close`.

A minimal smoke test:

1. Call `terminal_launch` with the absolute path to the sample TUI:

   ```json
   {
     "command": "node",
     "args": ["C:\\Users\\<user>\\TuiLens\\examples\\echo-tui.mjs"],
     "cols": 80,
     "rows": 16
   }
   ```

2. Save the returned `id`.
3. Call `terminal_observe` with `{"id":"<session-id>"}`.
4. Call `terminal_close` with the same ID.

Clients that support MCP image content receive a PNG screenshot as well as text metadata.
Clients without image rendering can still use the terminal text and snapshot metadata.

## Troubleshooting

| Symptom | Likely cause | Action |
| --- | --- | --- |
| `Cannot find module .../cli.js` | The project was downloaded but not built, or the path is wrong | Run `npm run build` and use the absolute path to `dist/src/interfaces/cli.js` |
| `spawn node ENOENT` | The MCP client does not inherit the shell `PATH` | Set `command` to the absolute `node` executable |
| No tools appear after restart | Client configuration was not reloaded, or the server failed to start | Check the client's MCP logs, verify the path, and restart the client |
| `node-pty` install failure | Unsupported Node version or missing native build tools | Use Node.js 22 or newer, run `npm ci`, and install the platform C++ toolchain if needed |
| Browser launch failure | No Chrome/Edge installation was detected | Run `npx playwright install chromium` or set `TUILENS_BROWSER_PATH` |
| Relative file or command not found | The client's working directory differs from the shell's | Pass an absolute `cwd` and absolute program or script paths in tool arguments |
| The `mcp` command appears to hang with no output | This is a stdio server waiting for JSON-RPC input | Test it through an MCP client, not as an interactive terminal command |
| Session processes remain after a tool failure | A session was not closed explicitly | Call `terminal_close`; disconnecting an MCP connection also releases sessions it created |

## Security and remote use

The MCP server can start arbitrary local programs with the permissions of the user running
the MCP client. Install only a trusted checkout, and review a scenario before running it.

The transport is local: Windows uses a named pipe and Linux uses an abstract Unix socket,
with a local authentication token. There is no public HTTP/SSE control endpoint. Install a
separate local copy for each user; do not expose the local daemon socket to another machine.

See [protocol examples](PROTOCOL.md) for tool and CLI argument shapes.
