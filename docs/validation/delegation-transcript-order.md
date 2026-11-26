# 委派子代理归入原执行过程

原界面将整个会话的委派任务放在 ChatList 的 footer。任务即使早于最终回复完成，卡片仍在最后显示，且在历史窗口中被隐藏。

修复复用原子代理卡片、执行器图标和详情：按当前任务版本的 startedAt，在所属父会话已加载的消息中寻找最近的前置消息，将卡片放入该消息所在的既有阅读行。开启工具分组时属于对应工作/工具组，关闭分组时跟随相应消息；最终汇总自然排在其后。没有插入模拟 provider 消息或改写原消息身份。

## 范围与边界

- 状态、完成时间更新保持在同一位置；同角色并行任务按开始时间排列。
- 元数据优先读取 V2，权威空列表不会回退到旧投影；父会话不符的任务不展示。
- 历史窗口只呈现窗口内任务。窗口末尾的长工具调用以实际 completedAt 扩展时间范围，未加载的更早或更新任务不借用当前行。
- 续接会话各用原父会话的任务与时间范围；从历史来源打开详情可读回原任务，追加和取消保持只读，当前对话与草稿不切换。
- 元数据摘要只包含任务当前版本。修订按本版开始时间归属，旧版本在原详情的版本列表中查看；本次不重建逐版本历史卡片。
- 卡片“已完成”仍表示子任务交稿，不证明主控已审阅、整合或保存。
- 容器沿用原卡片的布局与当前主题组件，不增加颜色 token、原生依赖、权限或 runtime 变更；共享 JS 按既有 CI 契约发布 OTA。

## 验证

| Case | 结果 |
| --- | --- |
| D1 子代理在工作过程与最终回复之间，分组开关均适用 | ChatList + 真实 transcript/grouping 回归通过；先复现 footer 顺序错误再修复 |
| D2 多回合、并行任务、状态更新和当前版本修订 | 自动回归通过，卡片不集中到最新答复后 |
| D3 历史分页与长工具边界 | 自动回归通过，区间内展示、区间外排除，原分页和阅读状态回归通过 |
| D4 续接会话隔离与原详情 | 来源父会话和只读操作组件回归通过 |

验证命令：

```sh
pnpm --filter happy-app test --run sources/components/ChatList.delegation.test.tsx sources/components/ConversationTranscript.pagination.test.tsx sources/components/delegation sources/components/ConversationTranscript.roleResult.integration.test.tsx sources/components/ChatList.streaming.test.tsx sources/components/subagent sources/components/transcriptReading.test.tsx sources/components/continuationTranscript.test.ts sources/hooks/useGroupedMessages.test.ts
pnpm --filter happy-app typecheck
pnpm --filter happy-app exec expo export --platform web
```

17 个文件的 280 项回归、完整类型检查和 Web 构建已通过；随后新增的原卡片来源选择回归单独补验。独立只读评审发现并推动修复历史长工具范围与历史任务追加问题，复审通过。

前后截图已询问待回复，未采集 PR 对比截图。正式上线、原会话浏览器交互和用户设备加载分别核验，不能用本地测试代替发布或实体手机验收；具体发行与设备结果由 Release OPS 本任务记录维护。
