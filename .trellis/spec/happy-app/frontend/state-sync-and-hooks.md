# 状态、同步与 Hooks

## 状态所有权

服务端主数据的唯一入口是 sources/sync。网络 payload 先经过 Zod 校验和解密，再由同步层归一化并写入 store。组件通过 storage.ts 暴露的 useSession、useSessionMessages、useMachines 等 hooks 读取，不在页面内维护第二份长期副本。

关键路径：

- packages/happy-app/sources/sync/apiSocket.ts：Socket.IO 连接与 RPC
- packages/happy-app/sources/sync/sync.ts：初始化、增量更新和失效刷新
- packages/happy-app/sources/sync/storage.ts：存储、selector 和 React hooks
- packages/happy-app/sources/sync/typesRaw.ts：不可信 wire payload 的解析与归一化
- packages/happy-app/sources/sync/reducer/reducer.ts：消息去重、权限和 tool 生命周期
- packages/happy-app/sources/sync/encryption/encryptionCache.ts：解密上下文缓存

同步层现有策略是失效后重取与 Socket 增量更新组合。新增主数据类型时，应接入同一初始化、更新序列和加密边界，而不是在页面 useEffect 中长期轮询。

## 本地状态

- 仅组件交互态使用 useState。
- 跨页面但不属于服务端主数据的状态，沿用已有 Context、Zustand 或持久化模块的所有权。
- 认证状态由 sources/auth/AuthContext.tsx 管理。
- 新会话草稿等复合交互抽成 hooks；参考 sources/hooks/useNewSessionDraft.ts。
- 非平凡 hook 放 sources/hooks，并写清输入、生命周期和副作用。

## 并发与失败

useHappyAction 负责常规用户动作的 loading 和错误展示。需要互斥的流程使用 AsyncLock。同步连接错误遵循既有自动重连和失效刷新，不把瞬时错误直接固化成页面级失败状态。

对 reducer 或归一化逻辑的修改必须保持：

1. 同一 messageId、localId 或 update seq 的幂等处理。
2. 乱序、重连和重复事件不会重复渲染。
3. 解密失败不会污染已存在的有效状态。
4. 协议变更同时核对 happy-wire、CLI producer 与 server router。

## 反例

- 组件 mount 时请求 sessions 并永久保存到 useState。
- UI 组件自行解密 wire payload。
- 在多个页面分别实现相同的 reconnect timer。
- 为避免类型错误使用 any 穿过同步边界。
