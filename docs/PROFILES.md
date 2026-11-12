# Terminal profiles

[English](PROFILES.md) · [简体中文](zh-CN/PROFILES.md)

Terminal profiles make the emulated terminal identity explicit. A profile owns the environment,
automatic replies, image capabilities, keyboard capability metadata, and scrollback used by a session.
`TERM=xterm-256color` is no longer hard-coded in the launcher.

## Built-in presets

Preset keys are accepted by `terminalProfile` / `--terminal-profile`. The displayed name is also accepted.
Version ranges describe the intended reference range; TuiLens does not detect the host terminal.
Launch profile paths resolve from `launch.cwd` (or the process working directory); `extends` paths resolve
from the declaring profile file.

| Preset | Reference range | `TERM` | Graphics | Keyboard |
| --- | --- | --- | --- | --- |
| `kitty` | `>=0.36 <1` | `xterm-kitty` | Kitty | Kitty + `modifyOtherKeys` |
| `wezterm` | `>=20230712 <2026` | `xterm-256color` | SIXEL + iTerm2 + Kitty | Kitty + `modifyOtherKeys` |
| `iterm2` | `>=3.4 <4` | `xterm-256color` | SIXEL + iTerm2 | `modifyOtherKeys` |
| `windows-terminal` | `>=1.18 <2` | `xterm-256color` | none | `modifyOtherKeys` |
| `alacritty` | `>=0.12 <1` | `alacritty` | none | Kitty + `modifyOtherKeys` |
| `vscode` | `>=1.85 <2` | `xterm-256color` | none | `modifyOtherKeys` |
| `tmux` | `>=3.2 <4` | `screen-256color` | Kitty | Kitty + `modifyOtherKeys` |
| `xterm-256color` | `>=276 <400` | `xterm-256color` | none | `modifyOtherKeys` |
| `linux` | `>=5 <7` | `linux` | none | none |

`xterm-256color` is the default. Presets are conservative reference declarations, not a claim that
every build of that terminal has every listed feature.

## Profile model

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

All top-level fields except `name` are optional in a file that has `extends`. Unknown fields are rejected.
`capabilities.scrollback` accepts 0–5000 rows and defaults to 2000.

## Replies and capabilities

- `CSI c` returns `replies.da1`.
- `CSI > c` returns `replies.da2`.
- `CSI > q` returns `replies.xtversion`.
- `CSI ? u` returns `CSI ? <capabilities.keyboard.kitty> u` when `kitty` is declared.
- If `replies.da1` is omitted, it is synthesized from `capabilities.color` and `capabilities.graphics.sixel`.
- Explicit DA1 feature `4` is kept in sync with `capabilities.graphics.sixel`.
- A missing `da2` or `xtversion` suppresses that reply. An empty reply string also suppresses it.
- `modifyOtherKeys` is capability metadata and participates in negotiated input encoding; TuiLens does not
  synthesize the XTQMODKEYS query response.
- `mouse`, `underlineStyles`, `synchronizedOutput`, `focusEvents`, `hyperlink` and `unicodeVersion` are
  declared metadata for matrix comparisons and future query handlers. They do not currently change the
  renderer's mouse tracking, underline drawing or Unicode table.

On Windows, system ConPTY answers DA1/DA2 before the browser emulator sees the query. Sessions that
explicitly select a profile (or override `graphics`/`images`) therefore use the bundled ConPTY DLL; the
default fast path without an explicit profile keeps system ConPTY. TuiLens also rewrites terminal-originated
DA1/DA2/XTVERSION/Kitty replies at `ManagedSession.protocolResponse` before they enter the PTY.

## Derived profiles

`extends` accepts a preset key/name or another JSON file. Objects merge recursively; arrays replace the
inherited value. Put only the differences in the derived file:

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

The derived profile keeps Kitty's other environment and capabilities. Its DA1 gains feature `4`, and the
Kitty query reports flag `3`. Relative file references resolve from the file that declares `extends`.
Cycles, missing files, invalid JSON, and inheritance deeper than 16 levels are errors. Profile files are
limited to 256 KiB.

## Launching

```sh
tuilens launch --terminal-profile kitty -- node app.mjs
tuilens launch --terminal-profile ./profiles/kitty-sixel.json -- node app.mjs
```

SDK:

```ts
const session = await manager.launch({
  command: "node",
  args: ["app.mjs"],
  terminalProfile: "wezterm",
});

const profile = await resolveTerminalProfile("./profiles/kitty-sixel.json");
const presets = listTerminalProfiles();
```

Precedence:

1. Built-in/default profile.
2. A file's `extends` chain.
3. `launch.graphics` overrides individual image protocols.
4. Deprecated `launch.images` overrides all image protocols when present.
5. `launch.env` overrides profile environment variables.
6. `colorMode` applies last to color environment variables and `capabilities.color`.

The session result includes the resolved name in `terminalProfile`.

## Scenario and performance matrices

Both scenario and performance specifications accept up to 32 unique `profiles`. The same workload is run
sequentially under each profile.

```json
{
  "version": 1,
  "launch": { "command": "node", "args": ["app.mjs"] },
  "profiles": ["kitty", "wezterm", "xterm-256color"],
  "steps": [{ "type": "wait", "conditions": [{ "kind": "text", "text": "READY" }] }]
}
```

A scenario matrix returns `matrix: true`, one entry in `runs` per profile, each with its own report path
and resolved `terminalProfile`. A performance matrix returns `matrix: true`, a per-profile `runs` array,
and a `table` with each metric's p50/p95/stability for every profile. A baseline file can be used with one
profile; multi-profile matrices reject a shared baseline instead of silently comparing different terminals.
A profile that cannot launch or produces no measurements is reported as a failed entry with
`reportPath: null`; it does not discard the other profiles' results.

Recordings persist the resolved renderer capabilities and replies without environment variables or the
profile's filesystem path. Replay therefore does not depend on an external JSON profile remaining available.
Older recordings that contain only `images` retain their previous replay behavior.

`examples/profile-matrix.json` runs a minimal DA1/DA2/XTVERSION/Kitty probe across all built-in presets.

## Deprecated `images`

`images` remains accepted for compatibility but is mapped to `capabilities.graphics`:

| `images` | SIXEL | Kitty | iTerm2 |
| --- | --- | --- | --- |
| `off` | false | false | false |
| `sixel` | true | false | false |
| `iterm` | false | false | true |
| `all` | true | true | true |

Use orthogonal overrides for new code:

```json
{ "graphics": { "sixel": true, "kitty": false, "iterm": false } }
```

Profiles, CLI/MCP schemas, and the TypeScript SDK share this model.
