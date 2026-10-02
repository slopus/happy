# 消息暂存队列受控验收

从 happy-app 运行 `node sources/trash/message-staging-queue/build.mjs`，仅通过 Ego 打开 `http://127.0.0.1:4391/`。

复用生产 MessageStagingQueueView、队列状态机、React Native Web、ginghamDark 主题及中文文案。替换外部任务执行器、持久存储、图标字体和 Unistyles runtime；输入框是测试控制器。没有真实账号、消息或网络写入。此入口不证明真实 SessionView、CLI RPC 或原生设备整条链路。

- Q1：运行中输入并发送三条；暂存三条，已发送为空。
- Q2：删除中间条；仅剩两条，已发送仍为空。取回末条编辑、重新入队。
- Q3：结束当前任务；只发送第一条。再次结束；发送第二条。
- Q4：重新加载，入队两条，点击末条“现在发送”；calls 仅记录 steer，当前 turn 不变，首条仍暂存。结束当前任务后首条发送。
- Q5：队列有消息时切换会话视图，结束任务，再切回；仍正常发送。
- Q6：390px 宽度下队列、按钮和输入区可见；按压/hover 使用语义主题色。

`window.fixture.calls` 只用于确认执行边界的顺序。持久恢复、复制标签页锁和失败竞态另由 messageStagingQueue*.test.ts 验证。

完整真实链路的 Ego 验收参见 `docs/testing/codex-native-message-queue.md`；这个受控入口仅用于状态机/UI 调试。
