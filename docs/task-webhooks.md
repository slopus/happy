# 通用任务 Webhook（协议 1）

Webhook 将外部事件交给已配置任务的目标机器执行。目录、执行器、模型、权限和固定指令仍来自任务所有者保存的机器加密配置。外部凭据只授权触发一个任务，不授权账户 API、创建会话或修改配置。

当前是 API 能力，没有新增 App 配置界面。Server 与执行机器的 CLI 都需包含本次实现；旧 CLI 不能领取带事件输入的运行，请求保留 pending，直到兼容 daemon 连接。无需数据库迁移。

## 配置、轮换、停用

先通过现有任务配置流程保存任务，选择机器、目录、固定指令与最小权限。任务的 `enabled` 只管理时间计划；希望仅由 Webhook 触发时，将时间计划关闭即可，不需要伪造远期日期。Webhook 开关独立于时间计划。

所有者用现有账户认证调用：

| 操作 | API | 请求 / 结果 |
| --- | --- | --- |
| 检查入口 | `GET /v1/scheduled-tasks/:taskId/webhook` | `{enabled:boolean}`，不返回密钥 |
| 开启 / 轮换 | `POST /v1/scheduled-tasks/:taskId/webhook` | `{enabled:true}`；返回一次性 `{token}`，旧凭据立即失效 |
| 停用 / 撤销 | 同上 | `{enabled:false}`；返回 `{}`，凭据失效 |
| 查看运行 | `GET /v1/scheduled-tasks/:taskId/runs` | 使用账户认证查看准确 run / session / turn 和状态 |

签发响应带 `Cache-Control: no-store`。把返回的 opaque token 直接交给调用系统的安全凭据存储；不要放 URL、Git、日志、聊天、浏览器 localStorage 或普通配置文件。数据库仅保存凭据 SHA-256，不保存原件。凭据中的公开路由提示不具有认证能力。

撤销只阻止新的 HTTP 触发，不撤回已经接受的执行。删除任务会取消尚未领取的运行；正在执行的任务继续沿现有会话控制处理。仅 Webhook 任务在时间计划持续关闭时修改配置，会保留已接受的运行及其旧配置快照。实际将开启中的时间计划关闭，仍沿用既有“取消待领取运行”行为。

## 外部 HTTP 调用

以下 Node 示例从调用系统注入的环境变量读取凭据，不把密钥写进命令行参数。生产调用使用受信任的 HTTPS API origin；本次未对正式服务上线。

```js
const response = await fetch(`${process.env.PAWS_API_ORIGIN}/v1/task-webhooks/${process.env.PAWS_TASK_ID}`, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${process.env.PAWS_TASK_WEBHOOK_TOKEN}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    requestId: '9da1ff3a-94e3-48a0-9e89-c70449c4b692', // 为业务事件生成一次并持久保存
    input: { event: 'document-ready', documentId: 'example-42', revision: 3 },
  }),
});
// 只记录非敏感的结果；不要记录 Authorization 或业务输入。
const receipt = await response.json();
```

成功返回 HTTP 202：`{requestId,runId,status}`。这是持久接受回执，不能解释为已经执行成功。相同任务和 requestId 配合相同数据返回原 run 及当前状态，即使已经终结、服务重启或凭据轮换后也不再执行；凭据仍必须有效。对象字段顺序不影响幂等比较。同一个 ID 配不同数据返回 409 `idempotency-conflict`。

| 结果 | 含义与调用方动作 |
| --- | --- |
| 202 | 已接受或已接受事件的重放；保存 runId |
| 400 / 413 | 输入不符合约束 / HTTP body 太大；修正后重新提交 |
| 401 | 凭据不合法、已停用、已撤销或不属于该任务 |
| 401（删除后） | 删除会撤销凭据，旧入口和状态订阅均不可用 |
| 409 `task-busy` | 当前有 pending/claimed/running/waiting/uncertain 运行；新事件未接受，也未占用 requestId。调用方保留原输入和 ID，等完成事件或人工动作后重试 |
| 429 `webhook-ingress-limit` | 单服务进程、同 IP 每分钟 60 次尝试（包括错误凭据和重放），带 Retry-After |
| 429 `webhook-rate-limit` | 同任务每分钟最多接受 10 个新事件，预算持久化；重复回执不消耗接受预算 |
| 429 `webhook-history-limit` | 当前版本每个任务最多接受 1000 个不同事件；历史与幂等记录保留。需要后续归档设计或配置新的任务，不能靠轮换密钥清空幂等保护 |

这是背压协议，没有服务端事件队列，不能把 409 当成功或丢弃事件。调用系统应使用其原有可靠投递/人工重试机制；本实现不新增周期状态查询。

## 输入、执行与状态边界

- `input` 是最多 32 个键的平面 JSON 对象；键长 1–100，值只能是字符串、有限数字、布尔或 null。字符串最长 4000 字符，总序列化 UTF-8 最多 8192 字节；整个 HTTP body 最多 16 KiB。不接受数组、嵌套对象或额外顶层字段。
- 输入按快照保存在运行中，并在固定任务指令后以“不可信外部 JSON 数据”明确标注投递。它不会被展开为 spawn 参数、命令、目录、模型或权限。任务作者应限定需要消费的字段，使用只读权限，并避免让任务把任意文本解释为操作指令；文本标签本身不提供模型语义层面的绝对注入防护。
- 固定配置继续机器加密，投递消息继续使用会话加密。外部事件输入在 Server 端可读，当前不提供输入端到端加密，不应传秘密或不适合服务端保存的数据。
- 机器离线时已接受请求保持 pending 并阻塞新的不同事件；机器连接或收到工作事件时单次领取。旧 daemon 无协议能力时不领取。Server 重启恢复计划与 pending；已领取运行不自动重新投递。
- journal 和原有回执继续保护恢复；未知启动/投递结果进入 uncertain，阻塞重叠。等待输入或 uncertain 需所有者按现有任务流程处理或显式结束跟踪，不会自动重发。
- 原定时和手动运行共用任务的活动运行锁。原手动合并语义保留，Webhook 不采用该合并行为。
- 状态变更复用 `scheduled-tasks-changed` 和机器 `scheduled-task-work-available` Socket 事件。外部系统也可用同一任务凭据订阅 `GET /v1/task-webhooks/:taskId/events`：初始快照与变更事件只含 activeRunId 和该任务的 runId/requestId/status/reason/updatedAt，不含账户、机器、加密配置、输入或会话内容。轮换、禁用、删除会关闭旧流。每任务最多 5 条流，最多 256 个活动作用域；当前仅支持单 Server 进程事件源。没有新增外部回调、业务轮询或可由请求指定的回调地址，外部凭据不授权订阅账户事件。
- 入口尝试预算在单进程内且最多记忆 1024 个 IP，重启会重置，不能替代公网网关的分布式防滥用措施。

## 验证入口

固定本机程序可选 `executionKind: local-handler`，加密配置指定 `localHandlerId`，必须独立运行（`newChatEachRun: true`）。daemon 只运行其账户/Server 作用域中私有 `handlers.json` 对应 taskId 和真实工作目录的固定 executable/args；数据来自 stdin，无 shell 插值。这个授权使用 daemon 的 OS 用户权限，不是 AI 沙箱。新 daemon 每次只领取一个新执行槽位，收到 Server 确认 running 才 spawn；已取消/uncertain/启动过期时不启动。回执持久保存与 ACK，损坏/陈旧回执不能阻断其他工作；执行中断不自动重放。

所有者可用 `packages/happy-cli/scripts/configure-task-handler.mts` 创建、轮换、撤销及移除本机登记，密钥直接进入 Account Pool / Keychain。完整配置例子、匿名网站的持久队列和 PNG/ZIP 回传见 [原话卡片示例](../examples/video-card-studio/README.md)。这是通用执行器的一种使用方式，B 站逻辑不进入通用 Server/daemon。

```sh
pnpm install --frozen-lockfile
pnpm --filter @slopus/happy-wire build
pnpm --filter happy-server-self-host exec vitest run sources/app/api/routes/taskWebhookRoutes.spec.ts sources/app/scheduledTasks/store.spec.ts sources/app/scheduledTasks/deadlines.spec.ts
pnpm --filter @wangjs-jacky/paws exec vitest run --project unit src/daemon/scheduledTasks
pnpm --filter @slopus/happy-wire exec vitest run src/taskWebhook.test.ts
```

CLI 的测试全局准备会构建 CLI/SDK；不要并发单独构建相同包或在其删除 SDK dist 时运行 Server typecheck。

真实模型验收（需要本机已可用的原生 Codex 登录；会消耗正常模型额度）：在仓库根执行 `node scripts/validation/task-webhook-smoke.mjs`。它启动仅绑定 loopback 的隔离 Server 和独立 HAPPY_HOME_DIR/daemon，用独立测试账户执行两条只读、无工具短任务，验证重复去重、忙碌拒绝、两份输入、唯一提示、解密回复及完成事件，再通过该 daemon 的本地控制接口停止自己的会话。测试私有数据在被忽略的 `.webhook-validation/`，不读取或切换现有 Paws 账户、不重启正式 daemon。

本次实际证据见 [验收报告](validation/task-webhooks-20261126.md)。
