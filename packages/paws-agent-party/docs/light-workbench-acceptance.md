# 亮色工作台与机器名称验收

日期：2026-09-18。基线：`4cd70e53b15c781f04b9952c44c4c87444b29bb3`。

## 范围与结果

| Case | 通过标准 | 证据与结果 |
| --- | --- | --- |
| 机器名称 | 显示主机名/自定义名称与状态，提交仍用机器 ID | `machine-label.test.ts` 覆盖名称、离线、空值及异常 metadata；`group-chat-machines-ui.test.tsx` 断言名称与原始 ID 提交；Ego 创建群聊实际选择 `fixture-mac-mini.local · 在线` 成功 |
| 亮色三栏与消息 | 导航、发言、成员职责分区；消息元信息可读；长内容不挤掉输入区 | Ego 在 1366×768 验证完整页面，三个区域无交叠、无水平溢出；35 行消息发送后时间线 scrollHeight=1461/clientHeight=358，可滚到底，输入区 bottom=768 |
| 弹窗与发送 | 创建群聊、模型表单、@ 选择、发送、Escape 与焦点恢复可用 | 1366×768 和 1024×768 的创建弹窗均在视口内且内部可滚动；Agent 管理 Escape 后焦点恢复；@ 选择与 Ctrl+Enter 发送成功 |

## 验证环境与边界

- 使用 `pnpm build` 产物及 `pnpm start:test`：完整 SPA、真实本地 API 与 Party 存储，SDK 边界为明确标记的测试替身，不连接真实 Codex，不消耗模型额度。
- 浏览器只使用 Ego，任务空间 114，runId `party-light-20260918-1158`；上述证据是可访问性树、实际交互和 DOM 几何测量，不是截图审美验收。
- 自动化：`pnpm exec vitest run --maxWorkers=2`，23 文件 / 108 测试通过；`pnpm typecheck`、`pnpm build` 通过。
- 独立代码评审未发现 Critical/Important 问题；发现的测试横幅 28px 高度补偿已修正。
- 用户截图确认仍待回复，遵循根 `CLAUDE.md` 未采集截图或视频；未宣称与设计稿逐像素一致或媒体已交付。
- 未改后端群聊派发、Codex 模型参数、辩论调度或增量上下文；真实 Agent 能力沿用对应已有验收记录，本轮不重复宣称。

## 复跑

1. 在包目录执行 `pnpm build`。
2. 为 `PAWS_AGENT_PARTY_DATA_DIR` 创建独立临时目录，运行 `pnpm start:test`。
3. 在 Ego 中打开日志中的本地 URL，用该目录的测试访问令牌进入。
4. 新建群聊，选择可读机器名称，工作目录使用 `/tmp`；发送 @ 消息，检查回复、消息滚动及输入区。
5. 打开 Agent 管理和新建群聊，核验 Escape、焦点恢复与低高度视口的内部滚动。

不要把测试替身页面或临时令牌发布到外网。正式发布仍需 PR 合并后由 main CI/CD 执行。
