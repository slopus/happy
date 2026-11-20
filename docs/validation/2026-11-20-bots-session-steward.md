# Paws 网页总管：源码实现与本地验收

日期：2026-11-20。基线：`c2201468de8d44caa60ed621cdb263112f4ec8ce`。
分支：`bots-session-steward`，sibling worktree：`happy--bots-session-steward`。

## 交付状态

源码实现、本地协议整合和构建已完成。没有部署或修改线上网关、worker、账号、会话或密钥。真实网页操作、真实模型选用工具以及真实远端执行/恢复尚未验收，不能将本记录称作线上功能已可用。

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

最终复核未发现遗留重要 P1/P2。没有运行实际浏览器，所以没有截图、Ego 操作或浏览器经验写回，不将组件测试称为真实页面验收。

## 启用所需的后续工作

1. 按 `docs/bots.md` 配置 worker 可达的私有 `PAWS_BOTS_SESSION_TOOLS_URL` 与现有 bridge secret；不得为此放开网关 loopback 或暴露任意公网入口。
2. 同步更新 source worker、gateway 和 Web 资源；仅发布网页不够。当前可选配置缺失时工具不提供。
3. 按项目的 PR/main CI 发布契约执行上线，再用真实网页总管控制一个独立远端测试会话验收。测试应覆盖排队/完成/失败、原会话恢复、授权等待时切换账号、页面断开及跨页目录。

没有推送、创建 PR、合并或发布。本地分支保留供后续评审与交付。
