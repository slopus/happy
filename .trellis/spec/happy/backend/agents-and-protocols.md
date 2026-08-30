# Agent 与协议适配

## 共享核心

src/agent/core/AgentBackend.ts 定义 backend 能力与启动配置，AgentRegistry.ts 负责注册和实例化。只有多个 provider 真正共享的能力才进入 core；命令参数、权限模式和恢复语义保持 provider 所有权。

## Provider 边界

- Claude：src/claude，SDK/本地 launcher、session scanner、权限和 session protocol mapper。
- Codex：src/codex，通过 app-server JSON-RPC 维护 thread/turn/item，Happy MCP bridge 只注入 Happy 自己的 MCP 配置。
- Gemini：src/gemini，ACP session 与 diff processor。
- OpenClaw：src/openclaw，独立 socket/backend。
- 通用 ACP：src/acp，协议 client、spawn、session 和 permission bridge。

每个 provider 至少分开处理：

1. 启动和恢复参数。
2. provider 事件解析。
3. Happy session envelope 映射。
4. 权限请求与用户答复。
5. 退出、取消、重连和 session ID 变化。

## 协议规则

共享消息、控制消息和 session envelope 从 @slopus/happy-wire 导入。packages/happy-cli/src/sessionProtocol/types.ts 只作为兼容 re-export，不在此继续定义平行类型。

sessionProtocol 当前仍是演进中的兼容合同。packages/happy-wire/src/sessionProtocol.ts 明确标记冻结的新消费者边界；不要无需求扩展 event union。协议变更必须同时核对：

- packages/happy-wire 的 Zod schema 和测试
- provider mapper 测试
- packages/happy-app 的 typesRaw/reducer/展示
- packages/happy-server 的事件路由或持久化类型

## Codex 配置

Codex app-server thread/start 的配置必须保留用户全局配置。Happy 自己的 MCP server 使用 dotted mcp_servers.<name> 覆盖，不能用一个完整 mcp_servers 对象抹掉 iDev 等全局 MCP。真实实现与回归测试见：

- src/codex/codexAppServerClient.ts
- src/codex/codexAppServerClient.test.ts
- src/codex/happyMcpStdioBridge.ts

## 反例

- 在 runCodex.ts 中复用 Claude 特有的 permission payload。
- provider 返回新 item 类型时直接 JSON.stringify 给 App。
- 为方便测试在生产 mapper 中接受缺失必填字段。
- provider 配置更新时覆盖用户完整 MCP、skills 或 sandbox 配置。
