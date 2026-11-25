# 同聊天切 Agent 的输入框组件验收

运行 `node sources/trash/in-chat-agent-switch/serve.mjs`，通过 Ego 打开打印的本机地址。复用实际 MessageComposer、MultiTextInput.web、RN Web、Shaker、ComposerAgentAction.web 和发送箭头 SVG；目录/权限选择器、Thinking 控件、剪贴板及提交端是合成边界。本夹具不创建服务器、账号、原生 worker 或真实模型请求。

最小复跑：

1. 点击“选择 Antigravity”：只设置待发送目标，events 不增加；新建会话与普通箭头同时可见。
2. 分别点击箭头、新建会话，再在输入框按 Enter：依次只记录“同聊天发送 / 新建会话 / 同聊天发送”；Tab 不创建会话。
3. “切换提交中”后两按钮禁用，Enter 不增加事件；恢复后取消选择保留正文，独立新建按钮消失。
4. 空正文无附件时箭头禁用，显式新建仍可用；恢复正文。
5. 桌面两个按钮分别约110×32、32×32，8px间距；390px下仍在输入框内且不重叠。
6. 键盘聚焦新建/发送有提示；系统偏好减少动态效果时，新建容器的 computed transitionDuration 为0s。

证据归 `test-results/in-chat-agent-switch/`（Git ignored）及当前 Happy Skills 关键步骤。组件状态 MP4 为已验证状态回放，不是连续录像，不代表实际模型、加密传输、完整 App 或原生设备验收。首轮沿用的旧夹具未透传Shaker style，修复夹具边界后才进行按钮真实尺寸验证；该轮不作为可见双按钮的通过证据。

完整发送/交接/路由/删除事务由同任务 Vitest 组合回归保护；真实正式入口验收另见 `docs/validation/in-chat-agent-switch.md` 及唯一发布记录。
