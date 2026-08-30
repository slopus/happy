# 测试与完成标准

## 测试位置

Vitest 测试与源码同目录，服务端主流后缀为 .spec.ts，也存在较新的 .test.ts；新增文件跟随相邻目录。路由使用 Fastify inject，领域 action mock 最小外部边界，纯工具直接测试。

代表性测试：

- sources/app/api/routes/machinesRoutes.spec.ts：路由与跨包合同
- sources/app/api/routes/v3SessionRoutes.test.ts：session API
- sources/app/events/eventRouter.spec.ts：scope 分发
- sources/app/presence/sessionCache.spec.ts：高频 presence
- sources/app/api/utils/enableErrorHandlers.test.ts：错误隐藏
- sources/standalone.spec.ts：自托管启动

## 命令

    pnpm --filter happy-server typecheck
    pnpm --filter happy-server typecheck:prod
    pnpm --filter happy-server test
    pnpm --filter happy-server standalone:dev

涉及 Prisma schema 时可运行：

    pnpm --filter happy-server generate

禁止运行 migrate、migrate:reset 或任何创建/执行 migration 的命令。

## 完成标准

- typecheck:prod 与相关测试通过。
- route 输入、鉴权和资源所有权都有失败用例。
- 写操作验证重试/重复调用与 version mismatch。
- 事务外副作用在 commit 后触发。
- 实时 payload 有 producer 与 consumer contract 覆盖。
- 5xx 不泄漏内部信息，日志不含凭据或密文正文。
- standalone 与外部服务模式的共享代码没有分叉。
