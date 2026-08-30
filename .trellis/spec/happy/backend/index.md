# Happy CLI 规范

## 适用范围

packages/happy-cli 的包名为 happy。它是用户入口、agent runtime 适配层、本地 daemon、加密 API 客户端和发布产物构建器。

## 先读什么

- 总体所有权：architecture.md
- Claude/Codex/Gemini/OpenClaw/ACP：agents-and-protocols.md
- daemon、API 与本地状态：daemon-api-and-persistence.md
- 日志、错误和秘密：logging-security-and-errors.md
- 测试与构建：quality.md
- 现有架构说明：docs/cli-architecture.md
- daemon 细节：packages/happy-cli/src/daemon/CLAUDE.md

## 总原则

- provider 差异留在对应 adapter/runner，共享生命周期进入 src/agent/core。
- 服务端通信只经 src/api；wire 合同优先来自 @slopus/happy-wire。
- daemon 是机器控制面，每个会话拥有自己的 ApiSessionClient 数据连接。
- 调试写文件日志，stdout/stderr 只用于用户界面或 agent 进程协议。
- 所有日志先经过 src/ui/logger.ts 的中央脱敏。
- 本地密钥、设置和 daemon 状态通过 persistence.ts 与 configuration.ts 管理。
