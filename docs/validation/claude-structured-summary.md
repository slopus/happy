# Claude Code 结构化摘要展示兼容

## 最终设计

基于用户指定会话补齐普通 assistant text 的展示：完整且独占整条回复、按顺序排列的 analysis+summary 标签，显示为紧凑的“结构化摘要”行。右侧独立“查看摘要”按钮打开只读弹窗，按“说明”“摘要”两段呈现 Markdown。用户进一步要求采用 Skills 旁边按钮打开窗口的方式，已替代最初的原位折叠方案。

复用 Paws DesktopDialogFrame、ScrollView、MarkdownView、Ionicons、Typography 和主题语义 token。弹窗桌面最大宽760，窄屏受当前窗口约束，高度受框架限制，内部独立滚动。支持关闭按钮、背景遮罩、Escape/原生返回请求；Web关闭后返回触发器焦点。路由/消息所有者卸载时弹窗一同卸载，不保留全局摘要状态。

保留原始消息、复制/分叉数据和只读策略。弹窗标题栏提供跨平台“复制原文”，摘要内Markdown强制只读，禁用选项发送和回执修改。不把标签识别当作原生thinking或压缩事件证明。不改变历史数据。代码块、内联、混合正文、嵌套或未闭合结构保持原样。自动压缩的指令延续不属于本次修复。

## 自动验证

- 6个关联测试文件，104项通过（含7项runtime契约）：解析边界、Web/模拟Android入口、弹窗打开/关闭/重开、原文复制/分叉、受限只读及现有Markdown/主题回归。
- 完整typecheck、Web export与git diff --check通过。
- 授权会话的原始普通text回复可成功识别；未将私有原始会话复制入仓库。

## 真实浏览器验证

使用独立worktree完整Expo Web export运行loopback候选，Ego读取用户指定的同一真实会话。当前账号登录态及外观仅在本机授权进程内转移，不公开发布，不输出或落盘凭据。

最终真实页面验证：摘要行右侧按钮有dialog/expanded语义；打开后单一dialog可见，关闭按钮获取焦点，长内容在弹窗内滚到底而背景聊天scrollTop不变；内部点击不关闭，关闭按钮、遮罩与Escape均可退出，焦点回到触发器，再次打开正常。Shift+Tab后焦点仍位于dialog。关键最终截图通过session/run/space/target绑定捕获并报告Happy Skills。

Ego对整张遮罩的语义点击会选到窗口遮挡的中心，不能当作产品故障；核对遮罩与卡片边界后点击可见外侧，真实背景关闭通过。

## 交付边界

代码在sibling worktree happy--claude-structured-summary，根仓库保持干净main。未提交、推送或发布。截图是候选版本，不是正式上线证据；未做用户手机/原生模态验收。没有native/runtime/依赖变更，若后续发布仍按工程OTA规则执行。

验收后清理仅本候选origin的临时登录态并关闭任务空间、停止本机预览服务。OPS方法写入ego-ops的paws/inspect-structured-reply-tags；全库校验另有既存条目错误，不宣称通过。


## 合并前独立评审

独立review发现两项P2并已复核关闭：手机原长按入口只能复制分段内容，现增加全平台复制原文；普通可写会话里的摘要选项可能发送消息，现强制只读且移除发送/跳过回调。Web及模拟Android均断言复制完整原文，可写和受限两类上下文均断言禁用摘要写操作。同步最新main后重建happy-wire产物，104项定向/runtime测试和完整类型检查通过。
