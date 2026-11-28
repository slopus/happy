# Android 暂停后编辑重发

## 问题与修复

用户在 Android 点击停止后，最近一条用户消息没有 PC 已有的编辑入口。基线为 `6b419f7a85e24b897a81bbbaefb733274c0c873c`。

根因是 `ChatList` 的普通及接续分支仅在 Web 启用消息操作，`MessageView` 用户操作栏又限制为 Web。已有编辑器与 `editedFromMessageId` 发送链路可以直接在原生复用。

- 开放原生用户消息操作；保留最近消息、非运行中、无待审批和非只读的编辑限制。
- 原消息处打开编辑器，沿用取消与重发；不在主输入框内新增常驻内容。
- 原生编辑器宽度跟随容器，移除桌面 320px 最小宽度；复制、编辑、取消和发送采用 48dp 高触控区域。
- 发送中同步锁定，避免同一回调重复提交；失败提示错误并保留草稿，可主动重试。
- 使用当前主题颜色；Web 助手消息操作仍沿用原平台限制。

## 自动验证

- 新增回归先复现原生入口缺失，以及首个发送回执前重复调用两次的问题，再验证修复。
- App 全量：662 文件、6,437 项通过。
- TypeScript 检查通过。新工作树首次检查因 ignored Expo 路由类型为空失败，复用 `packages/happy-app/e2e/fixtures/goal-board/repair-router-types.mjs` 从实际 `sources/app` 生成后通过；未修改工程配置。
- 普通/接续会话覆盖运行中→停止后可编辑，并验证发送携带 `editedFromMessageId`；既有历史、只读和待审批门禁回归保留。
- Android/iOS 组件回归覆盖原文加载、修改重发、取消、失败草稿/重试、编辑过程中恢复运行，以及快速连点只发一次。
- 独立代码评审通过，无待修问题。

## 原生验收边界

使用 API 36 Android 模拟器 `emulator-5584` 的 `build.paws.dev` 开发壳，通过实际 `MessageView` 的本机 fixture 验证。fixture 的运行状态和发送回调用于检查原生点击与编辑过程，不连接生产账号或真实模型。

| Case | 结果 | 证据范围 |
| --- | --- | --- |
| 运行中隐藏编辑，暂停后可打开 | pass | 实际 MessageView，fixture 切换可编辑状态 |
| 原文预填，修改后取消 | pass | 原生 TextInput、Pressable 与 Markdown 原文 |
| 修改并重发 | pass | 本地回调收到原 localId 与修改后的文本 |
| 320dp 和真实键盘 | pass | Gboard 拼音；编辑器与取消/发送按钮完整可见，触控高度 48dp |
| 失败保草稿并重试 | pass | 模拟失败提示，关闭后草稿保留，主动重试回调成功 |
| 非默认深色主题 | pass | ginghamDark 下实际编辑器与按钮边界检查 |

独立原生验收通过，80.9 秒连续 screenrecord 为 840×1890、H.264/yuv420p/30fps，完整解码通过。截图、录屏、回调日志、fixture 和重放步骤保存在本任务本机 Artifacts，由发行回执导航；媒体通过 Happy 私人会话交付，不额外公开上传。临时入口字节恢复，Metro/对应 ADB reverse 已停止，模拟器尺寸恢复。

完整 ChatList 的停止 RPC、真实模型发送、用户手机实际下载/加载/运行本次 OTA 未验。组件回归与模拟器结果不能替代这些证据。

未改变原生模块、权限、应用图标或 runtime，沿机器可读契约使用既有 OTA 渠道，不需要重新构建 APK。正式发布、preview/production 清单、主包核验与用户手机状态分别记录。
