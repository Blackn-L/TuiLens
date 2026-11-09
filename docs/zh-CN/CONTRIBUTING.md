# 贡献说明

[English](../../CONTRIBUTING.md) · [简体中文](CONTRIBUTING.md)

使用 Node.js 22+，执行 npm ci、npm run build，按需安装 Playwright Chromium。
修改分层前先阅读架构文档。

- 保持协议、引擎、会话和接口职责分离。
- 行为变更提供独立最小夹具，不依赖外部服务。
- 保留取消、输出顺序、容量上限和资源清理契约。
- 依赖使用精确版本，并更新锁文件。
- 不提交产物、凭据和机器专属配置。
- 明确终端/图像协议支持范围。

开发期间使用定向测试，最终执行 npm run check 和 npm test。
视觉变更同时检查 PNG 和结构化断言。
PR 说明触发条件、行为变化、验证与限制；文字存在不等于视觉正确，短测不等于长时稳定。

当前 package 为 private，不发布到 npm；整体再分发条款尚未选择，见 README 许可证说明。
