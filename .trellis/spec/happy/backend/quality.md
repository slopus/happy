# 测试、构建与完成标准

## 测试层次

Vitest 测试与实现同目录。纯 mapper、参数解析、权限和日志脱敏使用单元测试；provider/daemon 的真实进程边界使用 integration 配置。

代表性测试：

- src/codex/codexAppServerClient.test.ts：JSON-RPC、通知与 MCP 配置
- src/claude/utils/sessionProtocolMapper.test.ts：Claude 到共享 envelope
- src/daemon/daemon.integration.test.ts：进程与本地控制面
- src/ui/logger.test.ts：中央敏感信息脱敏
- src/modules/common/pathSecurity.test.ts：文件系统边界

修改共享 wire 或跨包行为时，增加 consumer contract 测试，不能只测 producer 序列化。

## Mock 原则

已有单元测试会 mock 外部进程、网络和时间；集成测试尽量走真实构建和临时环境。不要 mock 被测模块本身，也不要读取个人 ~/.happy。fixture 中不得保存真实 token、MCP payload 或会话日志。

## 常用命令

    pnpm --filter happy typecheck
    pnpm --filter happy test
    pnpm --filter happy build

只跑相关用例：

    pnpm --filter happy exec vitest run src/ui/logger.test.ts
    pnpm --filter happy exec vitest run src/codex/codexAppServerClient.test.ts

## 完成标准

- strict 类型检查、相关单测和 build 通过。
- daemon/provider 生命周期改动有退出与重连覆盖。
- wire 改动验证 App、Server、Agent 消费方。
- 日志路径通过敏感信息测试。
- CLI 用户输出与内部文件日志没有混用。
- PR 保持单一目的，并提供真实命令或端到端运行证据。
