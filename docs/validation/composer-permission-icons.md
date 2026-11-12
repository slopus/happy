# 输入框提示、权限与图标验收

当前基线：`44893a32de27a09e756ec6293a5d51f673e35034`。

| Case | 可观察要求 | 结果 |
| --- | --- | --- |
| H1 | 添加文件、权限和发送提示完整显示，保持在按钮上方，不受输入框/侧栏 overflow 裁切 | 通过 |
| H2 | 提示保持在视口内；顶部空间不足时翻到下方 | 通过（实际低高度视口与几何边界测试） |
| E1 | 逐档 hover 不产生额外灰球，仅真实滑块可以轻微放大 | 通过 |
| P1 | 权限浮层只保留请求批准、帮我批准、完全访问三档，无更多/预设/只读选项 | 通过 |
| A1 | Web 主按钮与加号按钮均 32px、内部图标与加号 20px、权限入口图标 16px | 通过 |

Web 提示通过平台专属 host 绘制到 document.body，使用触发器与提示的真实尺寸定位，监听 resize/scroll/ResizeObserver 并在隐藏时清理。原生提示保持原有布局。权限策略映射和已有会话风险确认未改。

验证使用 `e2e/fixtures/codex-settings/serve.mjs`：完整 App、隔离 PGlite、真实加密 socket/RPC/消息传输，模型目录与执行器为替身。无生产账号、外部模型调用。

真实浏览器仅通过 Ego 操作。1680×885 下，添加文件提示跨出输入框边界仍完整显示；权限/发送提示同样在 body 顶层。五档 Low/Medium/High/Xhigh/Max 的 hover 背景均透明。1024×300 下 Fast 提示的矩形为 (641.65, 28, 72.70, 33)，位于视口内；顶部翻转另由几何测试覆盖。

57 项相关组件和几何边界测试、应用 TypeScript 检查通过，独立静态复核通过。最终 10.07 秒录像为 H.264/yuv420p/30fps，经过完整解码及全时长抽帧检查；截图与可播放 MP4 已通过 Happy 私下交付。原生设备验收按用户已有决定跳过。

复跑入口：

```sh
pnpm exec tsx --tsconfig packages/happy-cli/tsconfig.json packages/happy-app/e2e/fixtures/codex-settings/serve.mjs
```

认证 URL 只在本机读取，登录后导航到无凭据地址。分别验证首页提示、权限入口与模型浮层。结束用 fixture 的 loopback `/shutdown` 清理本次环境。
