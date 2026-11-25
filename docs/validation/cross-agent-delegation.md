# 跨 Agent 委派验收

业务与状态约定见 [功能设计](../cross-agent-delegation.md)。此文件区分代码检查、真实执行器与用户设备证据，不把静态原型或合成测试表示为真实委派完成。当前主线发布、正式浏览器和设备验收结果持续维护于 [PR #903](https://github.com/wangjs-jacky/happy/pull/903)，本表保留各项证据边界。

| Case | 通过标准 | 自动化覆盖 | 真实执行验收 |
| --- | --- | --- | --- |
| D1 角色 | 自然语言工具或原位管理保存角色；失败保留草稿，修改配置不改变既有任务路由 | MCP、service、App API 与面板测试 | 真实保存与原生列举已运行；界面见 PR |
| D2 双向 | Codex→AGY 与 AGY→Codex 均使用目标真实模型，实际结果返回原父 scope | runtime、模型校验、ACP/Codex RPC 测试 | 两个方向已使用真实模型交稿，原始失败与补充审计分别保留 |
| D3 归属 | task/parent/child/输入/根回合精确绑定，无关回合、内部子代理及思考内容不能交稿 | journal、service、ApiSession 测试 | 真实 task/child/input/root 与结果标记核对；隔离反例由自动化覆盖 |
| D4 修订 | 新 requestId 产生下一版并复用同 child，旧结果保留；原 requestId 重试不重复创建 | service、结果面板测试 | 双向 V1→V2→V3取消→V4，复用同 child 并保留历史 |
| D5 取消 | 排队输入精确移除；运行中只取消对应根回合；原生自然完成不被改为取消；取消后可继续修订 | service、journal、ACP/Codex cancellation 测试 | 双向运行回合取消及取消后修订已运行；排队竞争由自动化覆盖 |
| D6 恢复 | 断线后读原任务、重连重发已知快照；不自动重投不确定请求、不假装恢复退出的 worker | service/runtime 文件事件与持久化测试 | 两次受控 daemon 激活、旧 worker 身份保留及重启后 V4/child/四版历史的单次持久读回通过；退出与不确定反例由回归覆盖 |
| D7 界面 | 助手入口、任务组和详情可达；版本与状态真实；“使用/追加”只预填，不擅自发送 | SessionView、ChatList、inspector、面板测试 | 按正式 Web 上线后 Case 验收，实际结果见 PR；手机独立验证 |
| D8 兼容 | 机器和父 worker 都支持能力后才可操作；旧 worker 显示新会话提示且不发不支持的 RPC | App API、面板与机器能力测试 | 按正式 Web 上线后 Case 验收，实际结果见 PR；手机独立验证 |

## 复跑

- `packages/happy-cli/src/daemon/delegation/*.test.ts`、`delegationRuntime.test.ts`、`delegationPermissions.test.ts`、`delegationModel.test.ts`：持久协调、ready journal、权限和实际模型校验。
- `codex/codexDelegationRpc.test.ts`、`agent/acp/runAcp.test.ts`、`agent/acp/AcpBackend.cancellation.test.ts`、`api/apiSession.test.ts`、`api/apiMachine.test.ts`：运行器绑定、配置确认、去重、取消和发布确认。
- `claude/utils/startHappyServer.delegation.test.ts`：真实 stdio→HTTP→模拟 daemon 的工具穿透，不能代替真实执行器。
- `packages/happy-app/sources/components/delegation/DelegationPanel.test.tsx`、`sync/apiDelegation.test.ts` 及 SessionView/inspector 相关测试：用户入口和状态行为。
- `packages/happy-cli/scripts/delegation-real-e2e.mjs`：默认 dry-run，不读凭据、不连接网络；显式 `--run` 验证专用新会话的真实执行器，`--native-parent true` 额外验证主控模型实际调用 `agent_roles` 和 `delegate_task`。

真实脚本的参数须明确指定服务器、机器、现有合成项目目录、两端模型和私有报告路径。CLI dataKey 凭据另外指定同一 daemon 的 retained sessions 路径；仅解析本次新建会话的密钥。凭据和旧会话原文不进入报告。脚本保留专用会话供界面复核，不自动停止 daemon 或删除历史。

PR 前后截图已询问，尚未收到选择，不作为合并门禁。真实浏览器关键步骤遵循宿主的会话绑定上报规则；原生手机需要独立设备证据。

首轮原生目录对“Neon”匹配到多个候选并明确拒绝，随后使用真实 `gemini-4-neon`，没有静默路由。AGY 原生工具 title 的协议保留已补齐；泛化工具摘要不作为工具身份。历史版本无交接内容不回退最新版本，取消等待提示仅在活跃状态显示；两项均有回归覆盖。
