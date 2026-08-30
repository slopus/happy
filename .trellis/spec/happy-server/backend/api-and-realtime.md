# HTTP API 与实时同步

## Fastify 路由

路由按领域位于 sources/app/api/routes。每条受保护路由声明 preHandler: app.authenticate，并通过 Zod schema 约束 params、querystring、body 和可稳定表达的 response。

现有例子：

- authRoutes.ts：公开认证端点与挑战输入。
- machinesRoutes.ts：认证、Zod params、幂等注册与 machine 更新。
- attachmentRoutes.ts：二进制/对象存储边界。
- v3SessionRoutes.ts：新版本 session API 与 contract 测试。

错误状态用 reply.code(...).send(...) 明确返回；500 响应由全局 handler 隐藏内部细节。不要把 Prisma error 或 stack 原样交给客户端。

## Socket.IO

sources/app/api/socket.ts 建立 /v1/updates，连接必须先验证 token 并标记 user-scoped、session-scoped 或 machine-scoped。各事件拆到 sources/app/api/socket 下的 handler：

- sessionUpdateHandler.ts
- machineUpdateHandler.ts
- artifactUpdateHandler.ts
- rpcHandler.ts
- pingHandler.ts
- usageHandler.ts

持久化更新通过 EventRouter 发出，并带用户级单调 seq。临时 presence/RPC 事件不伪装成持久化 update。recipientFilter 必须明确目标 scope，防止把机器专属数据广播给无关连接。

## 合同与幂等

客户端可能断线重试同一请求。创建/更新端点使用稳定 ID、repeat key、expectedVersion 或数据库唯一约束保证重复调用安全。冲突返回可恢复的当前版本，不覆盖较新状态。

跨包 payload 以 @slopus/happy-wire 和 App 的消费 schema 为准。machinesRoutes.spec.ts 直接用 App schema 验证 new-machine payload，是推荐的 consumer contract 模式。

## 反例

- 无 schema 的 request.body as SomeType。
- 写库成功前向 Socket 广播结果。
- 一个 socket handler 同时承担所有 scope 的授权分支。
- 通过 200 + 任意 error 字符串隐藏真实 HTTP 状态。
