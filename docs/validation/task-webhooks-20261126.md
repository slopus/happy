# 通用任务 Webhook 验收 · 2026-11-26

## 交付状态

通用 API、任务凭据管理、受限事件输入、持久幂等、显式背压、daemon 领取兼容门禁及真实模型执行已完成。未推送、未建 PR、未合并或部署生产，未做正式 Web / 当前手机设备验收。调用和限制见 [使用文档](../task-webhooks.md)。

工作区：`happy--task-webhooks-20261126`，分支同名，基线 `42785de5fa5a33cb4382c456639d0bb07e84fe9d`。只改本 worktree；根 main 只读核验，没有清理或重置。执行宿主 `jackydeMac-mini.local`，实际 Node `v24.20.0`；历史 CLAUDE 中 v24.14.0 路径已不存在，隔离测试显式使用当前实际 Node，没有修改现有 daemon 的稳定入口。

## 自动化验证

- 本会话执行 `pnpm install --frozen-lockfile`，没有继承父会话的安装/测试结论。
- happy-wire 构建与类型检查通过；新增数据限制和固定配置不变测试 1 项通过。
- Server 定向测试 40 项通过：真实 loopback HTTP + PGlite、凭据隔离/轮换/撤销、输入/体积、幂等/Unicode 字段顺序、并发串行化、忙碌拒绝不消费 ID、持久恢复、旧 daemon 不领取、速率预算、原终态和 deadline 边界。
- Server `typecheck` 通过。需先构建 paws-agent SDK；CLI 测试准备也会重建它，不能在删除 dist 的窗口并发检查。
- CLI 构建（定向测试 global setup 执行）及类型检查通过；原 journal/恢复/权限/worker 存在性测试 10 项通过。
- `git diff --check`、真实验收脚本 Node 语法检查通过。
- 首次误用 `pnpm test -- ...` 触发了全套 Server 测试：71 文件、722 测试通过，另 1 文件准备失败，21 测试跳过。失败是 `examples/ai-service-smoke` 未安装其独立打包 SDK 依赖（`@wangjs-jacky/paws-agent/services/node` 不可解析），不是 Webhook 测试失败。单独重跑该文件复现相同准备缺项；未修改无关示例依赖，也未声称全量 suite 绿色。

## 真实执行证据

最终运行 `node scripts/validation/task-webhook-smoke.mjs`，仅绑定 `127.0.0.1:53823`，独立 PGlite 数据目录、随机测试账户、独立 HAPPY_HOME_DIR 和本 worktree 构建的 CLI 1.3.19。执行的是原生 Codex，实际模型为其默认 `gpt-6.2-sol`，read-only / networkAccess=false，未改模型登录或权限。

| 输入 | runId | sessionId | 原生回复 | 终态 / 提示数 |
| --- | --- | --- | --- | --- |
| FIRST | `9aa4f1df-f79b-417b-bf99-e64258398424` | `cmwxl5mbd000amgg92u3kawnp` | `WEBHOOK_OK FIRST` | completed / 1 |
| SECOND | `488c5a8c-bbda-400e-9354-cd54ee8acae7` | `cmwxl5wul000nmgg91umjvpmr` | `WEBHOOK_OK SECOND` | completed / 1 |

准确 machineId 为 `b29137ed-9b86-4c9c-b7b6-29a1b3e2400b`，taskId 为 `bb5bc406-eecb-49d0-bdb1-c34909951506`。重复 FIRST 返回同一个 run；FIRST 运行中 SECOND 返回 409，没有创建第二个 run；FIRST 完成后重试同一 SECOND 请求 ID 被接受。两条会话均通过账户 API 解密历史核对实际正文和唯一 scheduledRun 提示，不只依赖 completed。收到 10 个任务状态变更 Socket 事件；观察器只在事件时单次读取状态，没有查询循环。

公开脱敏结果：[结构化证据](task-webhooks-evidence.json)。本机原始记录在被忽略的 `.webhook-validation/smoke-final.log` 与 `.webhook-validation/runtime-1795699557915/`；不把其私有运行目录纳入 Git。验收脚本保留在 `scripts/validation/task-webhook-smoke.mjs`，Server 入口为 `packages/happy-server/scripts/taskWebhookSmokeServer.mts`。

清理只针对测试自己的 daemon 和会话：本地控制 `/stop-session` 停止各自两条 worker，`/stop` 请求 daemon 停止。既有 daemon 退出路径未完全关闭连接，测试 daemon 仍尝试连接已停 Server，因此最终仅对本次明确 PID 做强制退出；没有清理其他会话或正式 daemon。复用脚本已加入一次性退出截止时间及仅对自身 PID 的兜底。临时账户 access.key 已删除；测试数据库与受限本机证据保留。

## 独立评审与修复

只读独立评审发现并修复：

1. 旧 daemon 会剥掉新增输入字段：新增 claim 请求 `taskWebhookProtocol:1`；默认旧调用不返回带 Webhook 输入的 run。
2. 未鉴权查找可能全表扫描：opaque token 带公开账户定位提示，用 `(accountId,key)` 索引读取；完整随机凭据哈希鉴权。同时添加有界 IP 尝试限流，覆盖错误凭据及重放。
3. Webhook-only 任务 false→false 编辑会取消已接受 pending：保留旧运行和配置快照，实际暂停和原手动运行语义保留。
4. Unicode 等价排序碰撞：指纹改严格字符串排序，补倒序 Unicode 双键重试回归。

前三项已由评审代理复核，最后一项有直接回归覆盖。最终 ASCII 原生执行与此前相同行为；最后 Unicode 指纹修复及接受预算改用轻量 receipt 时间戳读取用自动化回归验证，无需重复消耗模型请求。

## 真实覆盖范围

已真实覆盖外部 HTTP → 持久接受 / 去重 / 背压 → 事件通知 → 正确独立 daemon → 原生任务会话 → 实际回复 → completed。离线持久 pending、Server store 重建、重复 claim 不重投、uncertain 阻塞、凭据撤销、并发与失败终态由自动化验证覆盖；未冒称真实断电、长时间离线、多实例 Postgres 压力或生产重启演练。

本次没有浏览器操作、Cloudflare 部署、Android 改动、对外回调或周期业务轮询。公网 HTTPS、生产 Server / CLI 发布、正式入口和当前用户设备验收均未执行，不以本机隔离成功代替上线。

Happy OPS 已按真实隔离执行更新 `execution/diagnose-integration` 的操作、索引及本机证据导航，知识结构校验退出 0。没有浏览器操作，因此没有 Ego 经验或截图写回。
