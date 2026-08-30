# Daemon、API 与本地状态

## Daemon 职责

daemon 是机器级控制面，不是会话消息代理。startDaemon 在 src/daemon/run.ts 中负责：

- 单实例锁、版本与状态校验
- 注册 machine 和维护 ApiMachineClient
- 本地 127.0.0.1 控制服务
- 远程 spawn/stop RPC
- 子进程追踪、心跳与清理

每个 agent session 是 detached 子进程，并直接维护自己的 ApiSessionClient。因此 daemon 停止后，已存在会话可能继续在线；新远程会话和机器在线状态则受影响。

本地控制端点定义在 controlServer.ts，客户端调用在 controlClient.ts。新增端点要有明确 request/response 类型、只监听 loopback，并更新 daemon 集成测试。

## API 客户端

- api/api.ts：账户级 REST 与资源创建。
- api/apiSession.ts：session-scoped Socket.IO、消息、状态、RPC 与重连。
- api/apiMachine.ts：machine-scoped heartbeat、daemon state 与 RPC。
- api/encryption.ts：离开进程前的端到端加密。
- api/types.ts：共享 schema 的组合和本包事件类型。

Socket 更新采用 expectedVersion/seq 的乐观并发。version mismatch 应合并服务端当前值或触发明确刷新，不能盲目重试同一旧版本。

## 本地持久化

HAPPY_HOME_DIR 默认为 ~/.happy。configuration.ts 解析环境变量，persistence.ts 负责 settings.json、access.key、daemon.state.json 与锁。写入敏感文件时保持限制权限和原子替换；不要在其他模块直接拼 home 路径。

守护进程版本切换、损坏状态和 stale PID 都经 controlClient/persistence 的现有检查处理。不要用无条件删除整个 HAPPY_HOME_DIR 作为恢复手段。

## 相关测试

- src/daemon/daemon.integration.test.ts
- src/api/apiSession.test.ts
- src/api/apiMachine.test.ts
- src/persistence.test.ts
- src/utils/serverConnectionErrors.test.ts
