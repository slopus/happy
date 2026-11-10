# Codex 统一设置浮层验收

实现分支：`codex-unified-settings`。固定基线：`3e9d52ce`。范围：PC Web 新建会话及已有 Codex 会话；原生端、非 Codex 会话保留原选择器。以下为合并前的实现验收记录；发布结果另按 PR 和 Actions 核对。

认可稿来自原工作树 `happy--composer-mode-popover/docs/design/codex-real-ui-refined/`，该树的未提交组件和设计文件保持原样。本分支从当前干净 main 建立，安全带入原组件改动后完成正式实现。

## 结果

| Case | 验收标准 | 结果 |
|---|---|---|
| NEW | 模型、effort、Fast 同一入口；设置随首条消息传输 | 通过；真实加密接收端读回 terra/high/fast=true |
| CHAT | 同一浮层修改下一条消息；不改历史记录 | 通过；接收端读回 terra/max/fast=true，既有消息仍显示其历史模式 |
| CAP | Fast 仅在目录声明 priority 时可用；切换到不支持的模型时清除 | 通过；Astra 隐藏，切回 Terra 为关闭 |
| INPUT | 指针拖动释放提交、取消恢复；Space、Escape、焦点回入口 | 组件回归及 Ego 操作通过 |
| VIEWPORT | 短视口长列表可滚动到末项并选择 | 独立 Ego 900×550 验证通过 |
| THEME | 非默认深色主题的普通/按下/选中状态 | ginghamDark 独立浏览器检查通过，已恢复原主题 |

验收使用真实完整 App、隔离 PGlite、合成模型能力目录、真实加密传输。执行器 stub 接收并回执，不调用外部模型，因此不证明外部服务的响应速度、计费或模型实际执行。

## 静态与组件检查

```sh
pnpm --filter happy-app exec vitest run sources/components/SessionComposerModeSelector.test.tsx sources/components/SessionConfigPanel.test.tsx sources/utils/newSessionSpawnSettings.test.ts sources/sync/messageMeta.test.ts
pnpm --filter happy-app exec tsc --noEmit --pretty false
git diff --check
```

38 项测试通过；TypeScript 和 diff whitespace 检查通过。现有 CODEX-MODEL、R10 与 agent panel E2E 选择器已适配统一入口；本轮按全局规则使用 Ego 执行对应真实路径，没有运行 Playwright 浏览器。

## 前后图

两组均为 1680×885、DPR 1，同样的模型、effort 与 Fast 状态。固定基线在单独 worktree 运行，使用同一隔离后端。侧栏中的合成验收会话随独立评审增加，不用于侧栏像素回归。

| Case | Before | After |
|---|---|---|
| NEW | [Before](codex-unified-settings-media/new-before.png) | [After](codex-unified-settings-media/new-after.png) |
| CHAT | [Before](codex-unified-settings-media/chat-before.png) | [After](codex-unified-settings-media/chat-after.png) |

上述关键图均已通过会话/任务空间/target/URL 绑定的 helper 采集，并逐张通过 Happy `report_browser_step` 发送。没有重复普通图片附件。

## 视频

[验收视频](codex-unified-settings-media/acceptance.mp4)

20.03 秒，1680×886，H.264/yuv420p，30fps，faststart，静音。完整解码退出 0；覆盖七个状态的抽帧已核对，无凭据。视频为成功路径的逐状态演示，不是连续录屏，已通过 Happy `send_file` 发送。

同目录保留 `evidence.jsonl`、独立 JPEG 视频帧及本轮执行 recipe。recipe 内的任务/target 仅是历史证据，任务空间完成后不能直接恢复；新验收必须记录新的实际空间与目标。

## 独立评审

代码独立评审和 PC 交互回归均通过：已有会话的搜索、Fast 能力变化、拖动、Space、Escape/焦点恢复，以及新建首条消息状态显示和 900×550 长列表末项选择均通过。

ginghamDark 下普通透明、按下 rgb(31,42,56)、选中 rgb(40,53,68)，画面为深蓝主题；[主题截图](codex-unified-settings-media/theme-gingham-dark.png)已由独立评审上报 Skills。检查后恢复 adaptive/caramel 并刷新核对。未独立运行既有 Playwright 用例，真实页面回归由 Ego 完成。

两个 Ego 任务空间均已结束；临时基线 worktree 已移除；本次隔离 Web/Server/控制器端口均已停止。正式服务未切换。
