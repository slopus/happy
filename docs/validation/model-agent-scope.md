# 模型归属与跨 Agent 上下文交接（2026-11-24）

## 原因与行为

PR #883（312603a0d）在新建页和已有会话中无条件追加 Magpie 模型；选择该路由会改为 Codex，因此 Antigravity 等 Agent 的模型菜单也能悄悄切换执行器。

模型列表及回调现在只接受当前明确选中的 Agent 的目录。Magpie 属于 Codex 的连接，只在 Codex 下显示；同名模型不按名称推断归属。主动切换 Agent 后，输入框仍在同一机器和目录创建目标会话，源设置与草稿保留。

此前输入框的切换只新建空会话。本次复用已有 continuation 摘要准备与发送协议：创建前读取最新历史并保存有界文本摘要，目标载入后先持久化来源和摘要，再发送首条消息。发送管线仅注入一次，消息气泡仍显示实际输入。原生线程、模型和权限不跨 Agent 复制；工具与附件不包含在摘要内，也不重放原任务。

## 最小验收 Case

| Case | 通过标准 | 验证入口 |
| --- | --- | --- |
| M1 模型限定归属 | 新建与已有 Antigravity/Claude 菜单无 Magpie；越界 key 不改 Agent 或源设置 | SessionConfigPanel / useSessionAgentComposer.web |
| M2 主动切换 | Codex → Antigravity 才改变目标，模型与目录来自目标；切回可取消 | useSessionAgentComposer.web |
| M3 上下文交接 | Codex 记住随机词，切至 Antigravity 仅问旧词且准确回复、completed | 正式 Web 与真实执行端 |
| M4 失败与离开 | 历史不可读时不创建；摘要保存失败重试同 worker；保存中卸载不发旧草稿 | useSpawnSession / sessionContinuation.integration |

## 自动验证

- 原代码红测复现三处失败：两个列表的跨 Agent 目录污染，以及无目录校验的回调。
- 首批五文件 92 项通过；新增卸载竞态后，受影响的 useSpawnSession 28 项重新通过。
- 续接、发送组合、历史显示、浮层和 Android runtime 契约八文件 157 项通过。
- 最终完整 happy-app TypeScript 检查与 git diff --check 通过。
- 独立代码评审发现摘要保存期间卸载仍可能发送，已增加持有者检查与 deferred 回归，独立复审通过。

## 真实验收边界

遵循用户既有授权，待精确 head 检查和正常 PR 合并、既有 CI 正式发布后，在唯一正式入口使用专属合成会话测试；不另建隔离后端。不向原业务会话发送，不修改原项目文件，结束后只清理本轮测试对象。

当前真实浏览器/模型流程尚未执行；后续发布、会话与媒体回执由 Release OPS 的本机唯一记录维护。原生 Android/iOS 和用户其他设备未验，不以 OTA 制品代替装载证据。
