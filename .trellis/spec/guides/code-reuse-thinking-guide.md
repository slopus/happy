# 复用与所有权检查

## 先找所有者

新增逻辑前，先用 GitNexus 和 rg 找同类实现。Happy 的常见唯一所有者：

| 能力 | 所有者 |
|---|---|
| 跨包 wire schema | packages/happy-wire/src |
| App 主数据、解密与归一化 | packages/happy-app/sources/sync |
| App 通用列表、头像、Modal、宽度 | packages/happy-app/sources/components 与 sources/modal |
| CLI provider 无关生命周期 | packages/happy-cli/src/agent/core |
| CLI 文件日志与脱敏 | packages/happy-cli/src/ui/logger.ts |
| CLI 本地设置与密钥路径 | packages/happy-cli/src/persistence.ts、configuration.ts |
| Server 事务与提交后回调 | packages/happy-server/sources/storage/inTx.ts |
| Server 实时路由 | packages/happy-server/sources/app/events/eventRouter.ts |
| Codium 主题 token | packages/codium/sources/theme |
| Codium 通用控件 | packages/codium/sources/app/components |

## 何时抽取

满足以下任一条件时优先扩展所有者，而不是复制：

- 两个以上 consumer 解析同一个 unknown payload 字段。
- App、CLI、Agent、Server 中出现同名协议 object。
- 多个页面复制 Item、SelectButton、Avatar 或 Modal 的交互。
- 多个 provider 实现相同的 session 生命周期状态转换。
- Server 多个 route 重复同一事务、seq 或 recipient filter 规则。
- 两处日志 sink 各自维护敏感字段正则。

只有一个局部调用、且抽象会隐藏业务语义时，保留局部实现。不要创建无语义的一行 getter 或仅转发参数的 helper。

## 配置和常量

修改 event 名、RPC method、环境变量、端口、schema 字段或主题 token 前，使用 rg 搜索所有引用。尤其检查：

- @slopus/happy-wire 的 workspace consumers。
- docs 与 README 中的用户合同。
- self-host package 的 dependency drift。
- .web.ts、native 与 Tauri 并列实现。
- test fixture 和 snapshot。

## Reducer 与状态机

App 消息状态集中在 sync/reducer；Codium chat 状态集中在 Jotai write atoms；provider 生命周期集中在 runner/core。新增 action 或 status 时扩展现有 exhaustive switch/union，并增加未知值或重复事件测试，不在展示组件散落状态修补。

## 反例

- 在 App 和 CLI 各定义一份 UpdateMachineBody。
- 新建第二个 redact.ts，仅覆盖 Authorization。
- 每个 Server route 各写一次 transaction retry。
- Codium 组件直接根据原始 SDK delta 维护 chat snapshot。
