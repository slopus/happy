# Paws 网页总管：源码实现与云端验收记录

日期：2026-11-20。基线：`c2201468de8d44caa60ed621cdb263112f4ec8ce`。
分支：`bots-session-steward`，sibling worktree：`happy--bots-session-steward`。

## 交付状态

源码、本地协议整合和构建已完成，PR #854 已正常合并，正式 Web main CI 已发布。网关、Bots API 和 worker 已同步激活；真实网页总管目录分页通过，历史读取发现 int4 游标边界问题，补修与后续发送/恢复验收仍在进行。尚不能将本记录称作完整云端 E2E 已通过。

用户确认的范围是：只在已登录 Paws 网页里使用现有 Bots 总管；查询/读取全部会话、汇总有来源的进度、发指令、恢复中断会话并接收准确关联的结果。关闭页面后不要求继续跟进，不新增 PAT/API Key，也不交付账号主密钥。

## 能力与证据

| 能力 | 实现与本地验证 | 未验证的边界 |
|---|---|---|
| 全部会话目录 | `/v2/sessions` 游标分页；读取服务端快照并在宿主解密；坏记录单独列出 `unavailableSessionIds`，保留分页游标；混合好/坏记录回归通过 | 真实账号大量历史的实际耗时 |
| 历史与进度 | detached 解密分页，不改变用户阅读位置；不输出认证字段；输出截断标记、回合状态、等待数量；工具描述明确区分执行状态与交付证据 | 真实模型对复杂项目进度的归纳质量 |
| 发送指令 | 复用 `sync.sendMessage`；queued 回执与执行结果分离；保留本地消息 ID；宿主、网关和 Bots 原有 effect/approval 机制约束重复操作 | 真实远端执行器接收与执行 |
| 恢复原会话 | 复用原机器/原会话恢复，检查机器与历史标识、保留模型/权限/effort；不重放旧指令；账号/lifetime 检查贯穿凭据准备及 RPC 发出前 | 真实 daemon 恢复、首次新指令可执行 |
| 执行结果 | 按本次 localIds 识别根回合，跟踪同一 turn 的终态；忽略其他回合/子代理，不以空闲当成功；订阅先于读取，事件唤醒，单次 20 秒截止 | 老执行器缺关联字段时仅能报告未确认 |
| 生命周期 | 账号/服务器切换、pagehide、Bots 卸载均有取消边界；网关 SSE lease 到期/登出断开；连接 nonce 不能转移到新标签页；回执按连接清理 | 真实浏览器后台挂起/用户接管等实际体验 |

`paws_sessions_list` 返回非凭据的 `connectionId`；其他四种工具使用它，固定到同一个账号、空间、总管和网页连接。外部网络调用不能用这个 nonce 登录。服务端工具请求使用现有网关 bridge secret，浏览器只使用原 Bots lease；Paws bearer 和账号密钥不进入 Bots。

会话内容作为工具结果进入 Bots 后端和模型上下文，这是明确的数据流。历史视为不可信内容，写操作沿用现有审批机制。没有新增业务状态轮询或自动重试写操作。页面关闭不能撤回已交付的远端指令。

## 执行的检查

- `node --test integrations/rakazo/gateway/*.test.mjs`：33 项通过。
- Happy App：Bots 相关测试、`apiSocket`、Codex 账号授权/恢复、fork 和失败恢复：8 个文件、90 项通过。
- Bots executor、session tools 与 action approval：3 个文件、276 项通过。包含工具模型参数 schema、owner/group/非 chief 执行限制与审批分类。
- `pnpm --filter @paws/bots test`：2 个文件、3 项通过。
- `pnpm --filter happy-app typecheck`：通过。
- `pnpm --filter @rakazo/web check`：通过，包括 Web 和其 E2E 类型检查。
- Adapters 关闭声明输出后的完整语义检查：`tsc --noEmit --declaration false --declarationMap false -p tsconfig.json`：通过。
- 标准 `pnpm --filter @rakazo/adapters check`：生成本 worktree 的 Prisma client 后，仍在 12 个未改动函数处报告 TS2883，涉及 bot-secrets/run-effects/run-messages/schedule-tools/task-catalog/teaching-session 的 Prisma Json 类型声明推断。不把此项记作通过，也未修改无关函数来掩盖问题。
- `build:embedded`：通过；有上游 `import.meta` 和 sourcemap 构建警告。
- `expo export --platform web`：通过；随后将嵌入式 Bots 的哈希 JS/CSS 写入该本地导出，检查 HTML 引用及实际文件存在。
- `git diff --check`：通过。

整合测试 `sessionSteward.integration.test.ts` 使用真实 backend 工具调用函数、真实网关 HTTP/SSE 和浏览器流处理代码，经过宿主核心服务读写真实 AES 加密的隔离测试记录，得到准确的根回合终态，并覆盖读取与恢复。它不是完整 Paws 登录/同步层或真实模型/远端机器验收；未冒用测试数据宣称真实任务成功。

## 独立评审

独立 reviewer 检查了完整 diff 和新增文件。已修复并复核：

1. 恢复授权等待期间关闭网页后仍可能发出 RPC：新增端到端 caller fence，并先观察回归失败再修复。
2. 网关全局历史写回执永久占满容量：改为连接 nonce、每连接容量、断线清理；旧 nonce 无法绑定替代标签页，写签名只留哈希。worker 跨重启幂等继续由原 effect journal 承担。
3. 单个坏会话阻断整个目录页：分项处理错误并保留游标，新增回归。

最初源码评审未发现遗留重要 P1/P2。随后真实 Ego 验收揭示下列运行时与历史边界问题；组件测试没有替代真实页面验收。

## 启用所需的后续工作

1. 按 `docs/bots.md` 配置 worker 可达的私有 `PAWS_BOTS_SESSION_TOOLS_URL` 与现有 bridge secret；不得为此放开网关 loopback 或暴露任意公网入口。
2. 同步更新 source worker、gateway 和 Web 资源；仅发布网页不够。当前可选配置缺失时工具不提供。
3. 按项目的 PR/main CI 发布契约执行上线，再用真实网页总管控制一个独立远端测试会话验收。测试应覆盖排队/完成/失败、原会话恢复、授权等待时切换账号、页面断开及跨页目录。

## 云端验收进展与补修

- PR #854 的精确 head CI 全部通过，正常合并提交 `408a6a032560bf25fd935c7b53f6ed7e51901e66`；正式 Web CI `44672056689` 成功，Ego 页面 revision 与合并提交一致。
- 独立真实 Codex 测试会话收到固定基线回复并显示已完成；未对业务会话发送指令。
- 仅更新 worker 时，真实总管 find_tool 返回 unknown。核对源码发现 API 也通过 `runs.attach(jobHandlers)` 直接执行交互回合；同步升级 Bots API 并配置私有桥接后，总管真实目录两页各返回 2 条，并保留下一页游标。
- 历史初始游标原为 `Number.MAX_SAFE_INTEGER`，超出服务端 PostgreSQL int4；真实工具返回 history-unavailable。新增宿主契约回归先复现同错误，改用主同步已有的 `2147483647` 上界后通过，后续 beforeSeq 保持不变。
- 补修覆盖 Bots 5 个文件、24 项测试和完整 App typecheck；独立复核通过。API 和 worker 的可选桥接配置及激活说明同步更正。
- 完整历史读取、发送并关联准确终态、恢复原会话及断页边界仍待补修正式部署后验收；没有把工具目录、queued 回执或 launch acknowledgement 当作实际执行成功。
