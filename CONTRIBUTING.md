# Contributing

[English](CONTRIBUTING.md) · [简体中文](docs/zh-CN/CONTRIBUTING.md)

## Setup

Use Node.js 22+, run `npm ci`, then `npm run build`. Install a compatible browser if needed with
`npx playwright-core install chromium`. Read [architecture](docs/ARCHITECTURE.md) before changing layer boundaries.

## Changes

- Keep protocol, engine, session and interface responsibilities separate.
- Add independent minimal fixtures for behavior changes; avoid external services and environment-specific assumptions.
- Preserve cancellation, output order, capacity bounds and cleanup behavior.
- Use SemVer ranges for stable dependencies, keep the prerelease `node-pty` pin exact, and include the lockfile.
- Keep generated output, credentials and machine-specific configuration out of commits.
- Document support boundaries, especially for terminal/image protocols.

## Validation

Run focused tests while developing, then `npm run check` and `npm test` for the final state.
For visual changes inspect the generated PNG as well as structured assertions.
Describe the trigger, observable change, checks performed and remaining limitations in the pull request.
Do not equate text presence with visual correctness or a short benchmark with long-run stability.

## Documentation

Edit the English guides in `docs/` and their Chinese counterparts in `docs/zh-CN/`.
From the repository root, build and preview the Pages site:

```sh
npm ci --prefix docs
npm run build --prefix docs
npm run preview --prefix docs
```

Open the preview at `/TuiLens/`. To refresh the README image and sample HTML report, build TuiLens,
then run `node scripts/generate-docs-demo.mjs` with a supported browser installed. The generator uses
the public terminal example in this repository. The Documentation workflow builds pull requests and
publishes the site to GitHub Pages after a merge to `main`.

TuiLens is released under the [MIT License](LICENSE). Unless explicitly stated otherwise,
contributions are licensed under the same license.
Third-party components retain their own licenses; see [THIRD_PARTY.md](THIRD_PARTY.md).
