# Contributing

[English](CONTRIBUTING.md) · [简体中文](docs/zh-CN/CONTRIBUTING.md)

## Setup

Use Node.js 22+, run `npm ci`, then `npm run build`. Install a compatible browser if needed with
`npx playwright install chromium`. Read [architecture](docs/ARCHITECTURE.md) before changing layer boundaries.

## Changes

- Keep protocol, engine, session and interface responsibilities separate.
- Add independent minimal fixtures for behavior changes; avoid external services and environment-specific assumptions.
- Preserve cancellation, output order, capacity bounds and cleanup behavior.
- Use exact dependency versions and include the lockfile.
- Keep generated output, credentials and machine-specific configuration out of commits.
- Document support boundaries, especially for terminal/image protocols.

## Validation

Run focused tests while developing, then `npm run check` and `npm test` for the final state.
For visual changes inspect the generated PNG as well as structured assertions.
Describe the trigger, observable change, checks performed and remaining limitations in the pull request.
Do not equate text presence with visual correctness or a short benchmark with long-run stability.

The package is currently private and does not publish to npm. Public redistribution terms have not been selected;
see the license note in README before distributing a fork.
