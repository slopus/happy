# Happy Server 规范

## 适用范围

packages/happy-server 是 Happy 的私有服务端源码，提供 Fastify HTTP、Socket.IO 实时同步、Prisma 持久化、Redis/EventRouter 路由与 S3/本地文件存储。它只处理密文和账户元数据，不解密用户会话内容。

## 先读什么

- 服务启动与目录：architecture.md
- HTTP、Socket.IO 与更新序列：api-and-realtime.md
- Prisma、事务与事件：persistence-and-events.md
- 认证、日志与错误：security-logging-and-errors.md
- 测试与完成标准：quality.md
- 系统说明：docs/backend-architecture.md
- 包级既有约定：packages/happy-server/CLAUDE.md

## 红线

- Prisma migration 只由人创建和执行；Agent 可以改 schema、运行 generate、准备说明和测试，但不得生成或执行 migration。
- 所有外部输入使用 Zod/Fastify schema 验证。
- 客户端会重试，写操作应保持幂等或显式用 repeat key/版本号防重。
- 数据库事务只包含数据库操作；通知、对象存储和网络调用在提交后执行。
- 服务端不得记录 bearer、secret、加密 payload 原文或用户消息。
- 使用 privacy-kit 的 encodeBase64/decodeBase64 处理协议编码；不要散落 Buffer 转换新实现。
