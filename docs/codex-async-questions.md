# Codex 异步问题卡片

本阶段接入 Codex 的 `request_user_input_async`。问题出现在对话中时，任务继续执行；用户可以选择建议答案、填写自定义回答、稍后展开或跳过。主输入框与附件不参与问题编辑。

## 数据与状态

- 实时 `agentMessage` 和 `thread/read` 历史均保留 `delivery: async`、`questions` 和来源 item ID。
- Session Protocol 文本事件增加可选字段；旧客户端仍能阅读原正文。无效结构化数据回退到普通文字，不从 Markdown 列表猜测问题。
- App 归一化与 reducer 保留结构化问题。卡片替代该条消息的重复正文，并始终留在执行过程折叠组外。
- “稍后回答”只收起本地编辑器；“跳过”记录持久状态，不向模型提交默认答案。首项可以预选，但必须点击发送才提交。
- 回答/跳过的回执存于加密会话 metadata 的 `codexAsyncQuestionResponses`，以来源 item ID 索引，刷新和多端同步复用同一回执。

## 回答提交

新 RPC `codex-async-question` 由会话执行端处理。客户端只提交 item ID、动作和逐题答案；执行端从实际 Codex thread 读取问题，验证数量并构造带问题上下文的用户回复。

执行端先通过 metadata 的版本控制领取提交，再选择当前生命周期路径：

1. 当前有活动 turn：复用原生 steer。
2. 当前已结束：写入用户消息历史，等待 outbox 确认，再加入现有用户消息队列。

同一进程的重复请求复用 in-flight Promise；多执行器争抢通过持久领取回执决定胜者。已回答/已跳过的问题不再次发送。领取后发生网络结果不明或 worker 重启时保留答案并显示“发送结果待确认”，不自动改走另一条路径或重发；用户应先检查对话。队列接受不等于模型已处理完回复。

更新需要同时包含 App/Web 和 CLI。旧 worker 不随 App 更新热加载，新会话或正式恢复到新版 worker 后才提供回答 RPC；旧会话仍可阅读问题内容。未修改同步 `item/tool/requestUserInput` 的等待式交互。

## 已运行的检查

- happy-wire：异步问题与 Session Protocol schema，28 项。
- happy-cli：异步回答/重启恢复、原生 steer、实时/历史 mapper、app-server client，139 项。
- happy-app：卡片、MessageView、消息分组、归一化、metadata、流式身份、Android runtime 契约，78 项。
- 相关既有归一化、reducer 与主题回归，148 项。
- 全量 CI 暴露的输入框测试夹具回归，15 项：补充 LegacySessionComposerModeSelector mock 和缺失的字体常量；不修改输入框产品逻辑。
- App/CLI 类型检查、wire 构建及 CLI 构建通过。

CLI 模拟连接测试必须隔离父进程的账号绑定环境。例如：

```sh
env -u HAPPY_CODEX_ACCOUNT_PROFILE_ID -u HAPPY_CODEX_ACCOUNT_CREDENTIAL_VERSION \
  pnpm --filter @wangjs-jacky/paws exec vitest run --project unit \
  src/codex/codexAsyncQuestionRpc.test.ts \
  src/codex/codexSteerRpc.test.ts \
  src/codex/codexAppServerClient.test.ts \
  src/codex/__tests__/sessionProtocolMapper.test.ts
```

本轮未运行真实模型问答、浏览器交互或真机验收；截图选择已询问，尚未收到回复，因此未采集截图。组件测试覆盖了非默认深色主题的普通、hover、pressed、selected 表面；不将其表述为浏览器视觉验收。
