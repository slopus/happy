# agy Skills 与授权修复计划

> 使用 writing-plans 记录边界，按 executing-plans 在当前 worktree 直接实施；不新增用户确认节点。

目标：恢复 ACP 真实工具参数和技能读取展示，让授权按钮准确执行 agy 提供的单次或持续范围选项。

约束：根仓库保持干净 main；保留目标 Agent 默认权限；原业务会话只读；正式测试只清理本轮新增数据。

- [x] 以真实 ACP rawInput/Path/CommandLine 和本地 JSON-RPC 子进程补回归，先证明现状失败。
- [x] 保留 rawInput 与工具标题，关联权限 ID 与实际工具调用 ID；批准不能提前完成工具。
- [x] 向页面传递实际 ACP permission options，回传用户选中的准确 optionId；按 kind 判定，拒绝未知或不匹配选项，兼容无新字段旧 worker。
- [x] 将明确文件读取和纯技能读取命令纳入原有技能活动，保留工具详情及失败/等待状态。
- [x] 定向测试、App/CLI 类型检查、必要整套检查与独立审查。
- [ ] 按已授权发布流程交付并在当前正式入口复验；Web 与执行端分别核对。

审查重点：本地化选项名、同 kind 多范围、旧 worker、跨 Agent 默认权限不变、原调用 ID 与等待批准状态保持一致。

补充：真实 agy 只提供单次批准，持续授权由 Paws 会话权限策略实现，必须经过已有“完全访问”风险确认并取得 worker ACK。策略独立于模型设置，后续旧消息不能覆盖；旧 worker 显示升级提示。切换 Agent 的两条入口均采用目标默认权限。

本地交付验证见 [验证报告](../validation/2026-11-23-agy-skills-permissions.md)。真实上线及当前设备验收另记，不能由本地通过推定。
