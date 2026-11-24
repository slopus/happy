# Codex 风格会话锚点

## 实现与参考

- 原实现：`ConversationTranscript` 的滚动后锚点按钮与 `AnchorListSheet`。
- 用户提供的三张 Codex 截图作为短线、邻近放大及预览卡片的视觉参考。
- 代码参考：[T3 Code TimelineMinimap](https://github.com/pingdotgg/t3code/blob/de8551b05a9e3bc63fe60ca89a1b279dbe770457/apps/web/src/components/chat/TimelineMinimap.tsx)。沿用其 8px 间距、24px 短线及 1 / 2⁄3 / 5⁄12 / 1⁄3 的邻近缩放关系；MIT 原文保存在 `T3-CODE-LICENSE.txt`。
- 直接接入现有对话组件与稳定 ID 跳转，无另建消息列表或演示业务数据。

## 可见行为与边界

- 桌面 Web 对话列宽至少 520px、高至少 180px，且支持精细指针与 hover、至少有一条已加载提问或仍有较早历史时显示左侧导航。单条提问正常预览和跳转；当前页没有提问时显示可见目录入口，不回退旧胶囊。
- 保留 40px 导航空间，避免短线覆盖消息和文本选择。短线区域以外保持事件穿透。
- 当前阅读回合颜色加深；hover 邻近短线逐级伸长，卡片显示一行提问和最多三行最终回复摘要。仅解析当前预览、最多 1500 个字符。
- 回复包含分组内文本时仍取该回合最后的回复，不跨到下一条提问。预览按提问 ID 保持，加载旧历史不改变预览对象。
- 卡片只读且不拦截正文；移出/失焦/Escape 收起。方向键、Home/End 选择，Enter/Space 跳转；焦点有主题色轮廓。
- 顶部目录按钮复用原锚点列表与历史加载入口，不暗示未加载历史已经完整。
- 窄列、触控及原生继续使用已有锚点按钮/目录。Web 实现在 `.web.tsx` 内，原生入口为空组件。
- 普通表面、文字、次要文字、边框、阴影、焦点均来自当前主题；减少动态偏好会关闭过渡。

## 首轮实现的检查

`pnpm --filter happy-app typecheck` 通过。

定向 Vitest 共 160 项通过：

```sh
pnpm exec vitest run \
  sources/components/ConversationAnchorRail.web.test.tsx \
  sources/components/ConversationTranscript.pagination.test.tsx \
  sources/components/ConversationTranscript.browserProgress.integration.test.tsx \
  sources/hooks/useUserMessageAnchors.spec.ts \
  sources/themePacks.test.ts \
  sources/utils/otaRuntimeConfig.test.ts
```

包含 DOM 鼠标/键盘跳转、Escape、实际可见行的回合归属、历史插入后的稳定预览、窄列回退、目录入口及真实 `ginghamDark` 主题值消费。

## 验证限制

- 截图需求已询问，尚待回复；未采集前后截图或搭建截图环境。
- 上述 DOM 检查在 jsdom 中运行，不代表真实浏览器视觉或用户设备已验收。
- 当前无原生依赖、图标、runtime 或安装包身份变更；共享组件接入依照现有分类规则保守触发 OTA，无需因此重建 APK。
- PR、CI、正式 Web 与 OTA 回执另由发布记录核对，不以源码或本地检查代替上线。

## 用户当前会话复验与补修

首轮 PR889 已发布，但仅验了同时加载两条提问的短会话。用户随后报告仍是旧样式；在同一条真实会话复现：页面 revision 正确、对话列宽 912px、精细指针和 hover 均正常，锚点计数为 `1+`，仍显示旧胶囊。

原因是把当前历史窗口内的提问数量当作整个会话是否适合新导航的依据。长回合的初始分页可能只有一条提问，甚至暂时没有提问；`anchors.length >= 2` 因此触发错误回退。

补修取消两条门槛，并处理单条时的位置/指针计算、零条但有旧历史时的侧边目录入口。新增三项 DOM 回归在修复前因导航不存在而失败，修复后通过；连同既有导航、分页、浏览步骤、提问提取和主题检查共 156 项通过，完整类型检查通过。

此次仅修改 `.web.tsx`、对应 Web 测试和本文档，按统一分类规则跳过手机 OTA。上线后需回到原反馈会话验证 `1+` 场景，不得用另一条短会话代替。
