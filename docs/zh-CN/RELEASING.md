# 发布

[English](../RELEASING.md) · [简体中文](RELEASING.md)

`package.json` 是唯一版本源。`src/version.ts` 由 `scripts/sync-version.mjs` 生成，不要手工编辑；
两者不一致时 `npm run check` 会失败。

## 发布前检查

```sh
npm ci
npx playwright-core install --with-deps chromium
npm run check
npm run lint
npm run format:check
npm run test:coverage
npm run smoke:install
```

`smoke:install` 会构建、打包、在全新临时项目安装 tarball、导入 SDK 并运行 `tuilens --version`
和 `tuilens doctor`。它需要真实的 Playwright Chromium 安装，使 doctor 的浏览器检查解析到打包产物中的
`playwright-core` 路径；CI 的 `package-smoke` 会在运行前安装 Chromium。
本地覆盖率阈值为行 70%、分支 65%、函数 70%。

## 版本与 tag

1. 修改 `package.json` 的 `version`。
2. 执行 `npm run version:sync`。
3. 更新 `CHANGELOG.md` 与路线图。
4. 执行上面的发布前检查并提交。
5. 创建并推送与包版本一致的 annotated tag，例如 `v0.6.0`。

tag 会触发 `.github/workflows/release.yml`。工作流重复质量门禁、执行干净安装烟测、校验
`GITHUB_REF_NAME === v${package.version}`、带 provenance 发布 npm，并从自动生成说明创建 GitHub Release。

## 仓库密钥

在 Actions secrets 中配置有 `tuilens` 发布权限的 `NPM_TOKEN`。发布任务需要 `contents: write`
和 `id-token: write`，工作流已声明。
`publishConfig.registry` 固定为 `https://registry.npmjs.org/`，避免维护者本机镜像配置把真实发布重定向。

## 依赖策略

稳定依赖使用 caret 范围。`node-pty` 因当前只有预发布版本而精确锁定。可通过以下命令跟踪：

```sh
npm view node-pty dist-tags --json
```

定时 soak 工作流会归档该输出与 `npm outdated --json`。Dependabot 覆盖稳定 npm 依赖和 GitHub Actions。

使用 npm 12+ 时，消费项目需在根 `package.json#allowScripts` 中允许 `node-pty` 的原生安装脚本；
干净安装烟测已覆盖这一消费者形态。
