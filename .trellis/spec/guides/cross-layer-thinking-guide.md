# 跨包数据流检查

## 先画实际路径

Happy 的主要跨包流：

    Agent runtime
      → happy-cli provider mapper
      → @slopus/happy-wire envelope
      → happy-cli ApiSessionClient 加密
      → happy-server 存储与 EventRouter
      → happy-app sync 解密、归一化、reducer
      → React 组件展示

机器控制流：

    happy-app RPC
      → happy-server scope 路由
      → happy-cli ApiMachineClient
      → daemon spawn/stop
      → 独立 session 进程自报并连接

远程控制流：

    happy-agent
      → HTTP / Socket.IO
      → happy-server
      → machine/session scoped client

改动前标出每一箭头的格式、验证者、加密状态、seq/version 和失败重试方式。

## Wire 变更清单

- [ ] packages/happy-wire 有 Zod schema、inferred type 与正反测试。
- [ ] CLI producer/mapper 输出新合同。
- [ ] happy-agent 如消费该字段已同步。
- [ ] Server 存储类型、route 或 EventRouter 不丢字段。
- [ ] App apiTypes/typesRaw 能解析，sync/reducer 对重复与乱序幂等。
- [ ] legacy 与冻结 sessionProtocol 边界没有被无意扩大。
- [ ] docs/happy-wire.md 或用户协议文档仍描述当前设计。

## Machine / Session 状态清单

- [ ] user、session、machine scope 选择正确。
- [ ] expectedVersion、对象 seq 和 Account.seq 各自用途明确。
- [ ] 数据库提交后才 emit 持久化 update。
- [ ] daemon 停止与 session 子进程存活是独立状态。
- [ ] reconnect 会重放或失效刷新，不重复消息与权限项。
- [ ] stop、cancel、worker exit 和网络断开都会收敛到稳定状态。

## Auth 与加密清单

- [ ] 客户端边界完成加密，Server 不读取消息明文。
- [ ] bearer 验证后仍检查具体资源所有权。
- [ ] base64、nonce、key 长度和 legacy 解密有明确验证。
- [ ] 日志、Error、fixture、URL query 与 JSON dump 不含 token/secret。
- [ ] 二维码挑战、签名和持久 token 的生命周期没有被混为一谈。

## 发布与自托管清单

- [ ] happy-server 与 happy-server-self-host dependencies 无漂移。
- [ ] standalone 的 PGlite、本地文件和内存 bus 仍工作。
- [ ] 发布 tarball 包含 standalone、prisma、webapp 与 bin。
- [ ] 在无 workspace symlink 的临时目录安装并启动。
- [ ] Web、CLI、Server URL 环境变量仍指向同一实例。

## 跨包测试优先级

优先在 consumer 侧验证 producer 的真实 payload。现有例子是 packages/happy-server/sources/app/api/routes/machinesRoutes.spec.ts 直接用 App 的 ApiUpdateContainerSchema 验证 update。协议改动不能只截图 JSON 或只测试 TypeScript 编译。
