# 架构与目录

## 进程入口

sources/main.ts 启动外部 Postgres/Redis/S3 形态；sources/standalone.ts 提供 PGlite、本地文件和内存事件总线的单机形态。共享服务能力由 sources/index.ts 导出，自托管发布壳从这里构建。

启动顺序与关闭钩子见 docs/backend-architecture.md：数据库连接、presence cache、Redis、加密/GitHub/文件/auth 初始化，然后启动 API、metrics、presence timeout。新增后台循环必须注册 shutdown 清理。

## 目录职责

- sources/app/api：Fastify 实例、认证 decorator、routes 与 Socket.IO handlers。
- sources/app/events：EventRouter、持久化 update 与临时事件分发。
- sources/app/presence：高频 heartbeat 的缓存、批量写与超时。
- sources/app/<domain>：领域 action，一项核心动作一个文件。
- sources/storage：Prisma、事务、seq、Redis、文件存储与图像处理。
- sources/modules：跨领域外部模块，如 GitHub 与 master-key 派生。
- sources/utils：低层纯工具、日志、关闭与重试。
- prisma/schema.prisma：数据库模型；prisma/migrations 仅由人管理。

内部导入使用 @/ 绝对别名。文件和主要导出函数同名，例如 friendAdd.ts / friendAdd、separateName.ts / separateName。领域动作以实体加动作命名并写职责注释，真实例子见 sources/app/social/friendAdd.ts、sources/app/session/sessionDelete.ts、sources/app/kv/kvMutate.ts。

## 代码形态

使用 strict TypeScript、4 空格和函数式模块。接口用于对象合同，避免新增 enum，优先使用 Zod enum、字面量 union 或映射。类只在框架或长期状态确实需要时使用。

不要把一项业务动作直接塞进超长 route handler；可复用或涉及事务的逻辑放入对应 app/domain 文件。action 只返回调用方实际需要的数据，不为可能的未来用途扩张返回值。
