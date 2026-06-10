<h1 align="center">As Boss</h1>

<h4 align="center">
自部署的移动端 AI 编程助手 — 随时随地用手机指挥 Claude Code 和 Codex。
</h4>

基于 [Happy](https://github.com/slopus/happy) fork 并深度定制：全链路自建（服务端、构建、分发），去掉了上游的商业化依赖，并增加了多 Agent 群组协作能力。

## 与上游 Happy 的差异

- **品牌与命名**：App 显示名 `As Boss`，CLI 命令 `as-boss` / `as-boss-mcp`，本地数据目录 `~/.as-boss`
- **自建服务端**：默认连接自有服务器（不再依赖 happy.engineering 官方后端），提供 `Dockerfile.server` 一键容器化部署，并新增 `/v1/kv` REST 路由（GET / LIST / MUTATE）
- **群组协作**：`as-boss group` 一条命令同时拉起 Claude + Codex 会话，App 端 Groups 页以合并时间线展示多 Agent 消息，按角色着色，工具调用复用 MessageView 渲染
- **去商业化**：移除 RevenueCat、PostHog、ElevenLabs 等第三方 SDK
- **ACP 通道增强**：tool result 通过 ACP 通道下发，App 会话详情页可直接查看工具输出
- **自有构建**：Android 通过 EAS 构建分发，配置 EAS Update 热更新

## 工作方式

在电脑上用 `as-boss` 代替 `claude` / `codex` 启动 AI 编程会话。需要在手机上接管时，会话切换为远程模式；回到电脑按任意键即可切回。消息全程端到端加密，服务端只做加密同步，不持有明文。

## 仓库结构

pnpm monorepo，主要包：

| 包 | 说明 |
| --- | --- |
| `packages/happy-app` | 移动端 + Web 客户端（Expo / React Native） |
| `packages/happy-cli` | CLI，包装 Claude Code 与 Codex，提供 `as-boss` 命令 |
| `packages/happy-server` | 自建后端，加密同步 + KV 存储 |
| `packages/happy-agent` | 远程 Agent 控制 CLI（创建、发送、监控会话） |
| `packages/happy-wire` | 通信协议层（消息 envelope、ACP） |
| `packages/codium` | 内置 worker 宿主 |

## 开发

```bash
pnpm install

# 起 Web 客户端
pnpm web

# 起 CLI
pnpm cli

# 本地开发环境管理（server 等）
pnpm env:list
pnpm env:server
```

更多文档见 [docs/](docs/)：架构（`cli-architecture.md`、`backend-architecture.md`）、协议（`protocol.md`、`encryption.md`）、部署（`deployment.md`）等。

## 致谢与许可

本项目 fork 自 [slopus/happy](https://github.com/slopus/happy)，感谢上游作者们的出色工作。

MIT License — 详见 [LICENSE](LICENSE)。
