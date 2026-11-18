# 讨论模式：实现与验证

## 已确认需求

项目和任务都需要明确的讨论入口，沿着对话逐步追问，而非固定问卷。项目使用初始想法、触发经历与已有讨论；任务继承项目目的并结合自己的来源、历史和边界。只有用户明确认可的复述范围属于共识；允许局部共识与后续修订。形成共识不自动开始计划或实施。

## 实现

- 基线：517d7099f94e23edeac4f50cc807d23130b8cd03。
- SessionView 输入框下方新增「讨论 / 讨论中」按钮，项目/任务内嵌聊天和普通聊天共用。禅模式保留入口；执行中禁止切换，切换只影响后续消息。
- 当前设备按 session ID 保存模式，刷新和会话往返可从 LocalSettings 恢复；不是跨设备同步。
- 规则集中在 sources/sync/discussionMode.ts。每条讨论消息加入适应性追问、项目/任务背景、共识区分和不实施规则，聊天/草稿保留用户原始文本。
- Codex 使用 read-only，Claude 使用 plan；保留模型、推理强度及 fast 选择。其他 agent 暂不提供开关。
- 后续消息通过暂存队列快照权限。讨论消息禁止 steering 到执行中的 turn，只在独立下一轮使用对应权限。失败回合的继续动作也遵循当前讨论模式。
- 关闭讨论恢复原有权限选择，随后非 slash 消息明确通知模型已退出讨论；不把历史共识当作实施授权。
- 使用已有 metadata.goalBoard 提供 featurePath/taskId；未绑定的普通/新建会话使用既有聊天与工作目录背景。背景读取由模型完成，没有自动证明档案已被读取，也没有自动写入共识或改变任务状态。

## 验证

命令（在 packages/happy-app）：

```
pnpm exec vitest run sources/-session/SessionView.agentSpace.test.tsx sources/-session/SessionView.hydration.test.tsx sources/sync/discussionMode.test.ts sources/sync/messageStagingQueueRuntime.test.ts sources/sync/messageStagingQueue.test.ts sources/sync/localSettings.test.ts
pnpm typecheck
```

结果：6 个测试文件、171 项通过；完整 App typecheck 通过；git diff --check 通过。独立 reviewer 初审发现队列 steering 绕过权限和禅模式隐藏入口，已修复并补回归，复审代码与交互逻辑 pass。

| Case | 自动验证 | 浏览器/原生/模型验证 |
| --- | --- | --- |
| 输入框讨论入口在禅模式保留 | SessionView 组件回归通过 | 未执行 |
| 项目与任务背景及适应性讨论规则 | 规则构建回归通过 | 真实模型行为未执行 |
| 讨论消息保留原文与权限快照 | 实际 staging runtime 回归通过 | 真实传输/模型未执行 |
| 讨论不插入执行中 turn | 队列状态转换回归通过 | 未执行 |
| 关闭讨论恢复普通权限 | staging runtime 回归通过 | 未执行 |

## 交付边界

代码在 sibling worktree happy--discussion-mode，分支 feat/discussion-mode。没有推送、创建 PR、合并、发布 Web 或 OTA，没有更换本机 CLI/daemon。未做浏览器 E2E、截图/视频、真机或真实模型行为验收；上述测试不能替代这些结果。未启动浏览器任务，无新的 Ego 站点事实可沉淀。
