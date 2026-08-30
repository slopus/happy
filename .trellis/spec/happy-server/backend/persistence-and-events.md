# 持久化、事务与事件

## Prisma 与事务

数据库入口是 sources/storage/db.ts。多步写使用 sources/storage/inTx.ts，它以 Serializable transaction 执行，并对 P2034 冲突做有限退避重试。

事务内只执行数据库操作。通过 afterTx 注册提交后事件；文件上传、HTTP、推送等非事务资源在事务外完成。不要假设外部副作用能随 Prisma rollback。

    return inTx(async (tx) => {
        const record = await tx.machine.update({ ... });

        afterTx(tx, () => {
            eventRouter.emitUpdate({ ... });
        });

        return record;
    });

真实模式见 sources/app/api/routes/machinesRoutes.ts 与 sources/app/social 下的 action。afterTx callback 不应返回影响事务结果的 Promise 链；需要强一致的外部交付时应设计 outbox，而不是把网络调用塞回事务。

## 更新序列

Account.seq 是用户级更新序列，allocateUserSeq 位于 sources/storage/seq.ts。Session、Machine、Artifact 的局部 seq/version 用于对象顺序与乐观并发。新增持久化事件必须：

1. 在提交后分配/使用正确序列。
2. 生成稳定的 UpdatePayload。
3. 选择精确 recipientFilter。
4. 由相关客户端 schema 验证。
5. 处理重复或乱序接收。

## Schema 与 migration

可以在明确需求下修改 prisma/schema.prisma，并运行 pnpm --filter happy-server generate 更新 Prisma client。不得创建、编辑或执行 prisma/migrations；把预期 schema 变化与回填要求交给人。

## 存储边界

- S3 与本地文件由 sources/storage/files.ts 统一抽象。
- 图像处理与 thumbhash 在 sources/storage/processImage.ts、thumbhash.ts。
- Redis 初始化在 sources/storage/redis.ts。
- standalone 的 PGlite 适配由 pgliteLoader.ts 管理。

对象存储 key、路径和公开 URL 必须通过现有 helper 构造，并校验所有权；不能接受用户提供的任意本地路径。
