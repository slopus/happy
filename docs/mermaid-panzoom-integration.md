# Mermaid + Panzoom 跨端组件指南

本文记录 Paws 中 Mermaid 交互画布的稳定用法，以及在 PC Web、触控板、Android WebView 和全屏模式下已经验证过的边界。修改相关代码前，先把这里的“交互契约”和“回归矩阵”当作组件 API 的一部分。

相关实现：

- [`MermaidRenderer.tsx`](../packages/happy-app/sources/components/markdown/MermaidRenderer.tsx)：跨端渲染、工具栏、手势和全屏
- [`mermaidRendererModel.ts`](../packages/happy-app/sources/components/markdown/mermaidRendererModel.ts)：主题映射、命令和安全序列化
- [`MermaidRenderer.test.tsx`](../packages/happy-app/sources/components/markdown/MermaidRenderer.test.tsx)：Web 组件契约
- [`MermaidRenderer.native.test.tsx`](../packages/happy-app/sources/components/markdown/MermaidRenderer.native.test.tsx)：Native/WebView 契约
- [`mermaid-diagram-interactions.spec.ts`](../packages/happy-app/e2e/mermaid-diagram-interactions.spec.ts)：PC Web 真实交互回归

## 1. 对外用法

业务调用方只传 Mermaid 源码，不直接接触 Mermaid 或 Panzoom 实例：

```tsx
<MermaidRenderer content={'flowchart LR\nA --> B'} />
```

Markdown 渲染链识别 `mermaid` fenced code block 后调用该组件。缩放、拖拽、主题、错误回退和全屏都由组件内部负责；不要在上层消息列表重复绑定 wheel、pointer 或全屏手势。

当前依赖契约：

| 能力 | Web | Android/iOS |
| --- | --- | --- |
| Mermaid | npm 包，动态 `import('mermaid')` | WebView HTML 中的固定版本脚本 |
| Panzoom | npm 包，动态 `import('@panzoom/panzoom')` | WebView HTML 中的固定版本脚本 |
| 宿主 | React Native Web 中的 DOM viewport + scene | `react-native-webview` |
| 命令 | ref 直接调用 Panzoom | `injectJavaScript` 调用 `window.__pawsMermaid` |

Web 与 Native 是两条渲染链，不能因为最终都显示 SVG 就假设配置、尺寸和事件行为天然一致。

## 2. 不可破坏的交互契约

### PC Web

- 桌面（Web窗口宽≥768px）以自然比例预览 SVG，默认节点文字为16px、接近正文，不随消息栏拉宽而放大，也不为塞进横图而缩小。图框靠左并按自然图宽收紧、最大不超过消息宽；高度最多为480px或窗口高度60%中的较小值，超宽/长内容裁切，点击预览打开完整大图。
- 窄屏 Web 保留按消息宽度等比排版、从顶部开始展示的行为，高度最多为窗口的70%；不按高度缩成完整缩略图，短图按实际图片高度收缩。
- 内联不初始化 Panzoom、不提供缩放工具栏，鼠标与触屏滚动归聊天页。
- 放大徽标占用独立顶部留白（内容顶部46px、左右/底部16px），不能覆盖自然高度横图的末尾节点。
- 全屏中鼠标或触控板按住画布后，默认缩放比例也必须能够拖动画布。
- 普通鼠标滚轮、触控板双指滚动属于页面，不能缩放图表，也不能被图表阻止。
- `Ctrl/Command + wheel` 才交给 Panzoom 缩放；工具栏的放大、缩小、重置始终可用。
- 打开全屏会创建独立画布实例；关闭后返回同一张静态预览，支持 Escape 和关闭按钮。
- 大图以深色遮罩上的独立圆角画布承载，右上角下载/关闭，底部居中为减号、实际缩放百分比、加号；点击百分比重新适配整图。
- 初始比例以 SVG 原始 viewBox 尺寸适配画布，百分比是相对原图的实际比例，不把适配后的比例伪装成100%。
- 下载导出完整 SVG，保留原始宽高、中文与换行，不导出当前拖拽后的裁切画面。

### Native/WebView

- 内联 WebView 按宽度展示顶部静态 SVG，高度上限同样为屏高的 70%；SVG/scene 使用自然高度、不按视口高度缩图。ResizeObserver 仅在图片自然高度变化时通过消息桥接调整短图容器，无轮询。`pointerEvents="none"`、`scrollEnabled=false`，由外层 Pressable 打开全屏，让父聊天页处理触摸滚动。
- 仅全屏 WebView 开启 `scrollEnabled` 与 `nestedScrollEnabled`，并加载 Panzoom。
- 全屏 HTML 不保留内联模式的 16px body padding。
- Modal 同时处理状态栏、导航栏和安全区；外层为操作区和底部缩放条预留空间，圆角画布不遮住控制按钮。
- 缩放、拖拽和重置由 WebView 内的 Panzoom 完成，React Native 工具栏只发送命令。

## 3. 推荐实现结构

### 3.1 分开 viewport、scene 和 SVG

内联 SVG 先按 HTML 解析、移除 HTML 解析器产生的 xmlns 属性，再用 XMLSerializer 序列化为 SVG 图片 URI。Mermaid 的 foreignObject 中可能包含未自闭合的 `<br>`，直接把原始输出塞入图片会造成 XML 解析失败；不能只用无文字的 mock 验收。

全屏 Web DOM 层级保持为：

```text
viewport（裁剪、手势边界、wheel 监听）
└── scene（Panzoom target，承载 transform）
    └── svg（Mermaid 输出）
```

职责不要混用：

- `viewport` 负责尺寸、居中、`overflow: hidden` 和 `touch-action: none`。
- `scene` 是 Web 端的 Panzoom target；E2E 也读取它的 CSS transform 判断交互是否生效。
- `svg` 只负责内容尺寸和 `preserveAspectRatio`，不要再单独绑定一套手势。

当前稳定配置是：

```ts
Panzoom(scene, {
    canvas: true,
    startScale: fitScale,
    minScale: Math.min(0.1, fitScale / 2),
    maxScale: 5,
    step: 0.25,
});
```

HTML scene保留原始viewBox宽高，Web和Native都将Panzoom绑定到HTML scene，使用库默认中心原点；不能给SVG target强制改中心origin，否则会破坏焦点缩放。fitScale取可用画布与原图宽高比例中的较小值（上限1）。监听panzoomchange更新百分比；ResizeObserver在画布尺寸变化时重新适配，不查询或轮询状态。

不要恢复 `contain: 'outside'`。当图表在默认比例已经完全落入 viewport 时，该约束会把位移夹回原点，用户看起来就像“长按无法拖动”。这不是 pointer 事件没触发，而是变换被 containment 规则抵消。

### 3.2 明确 wheel 的所有权

不能把 `panzoom.zoomWithWheel` 无条件注册到 viewport：

```ts
const onWheel = (event: WheelEvent) => {
    if (!event.ctrlKey && !event.metaKey) return;
    panzoom.zoomWithWheel?.(event);
};

viewport.addEventListener('wheel', onWheel, { passive: false });
```

关键点：

1. 普通 wheel 直接返回，不调用 Panzoom，让事件继续驱动页面滚动。
2. 只有修饰键缩放时才允许 Panzoom 执行自己的 `preventDefault`。
3. 监听器必须是 `{ passive: false }`，否则浏览器不允许缩放分支阻止默认行为。
4. 清理时必须使用同一个函数引用移除监听器。

Mac 触控板的普通双指滚动与浏览器缩放手势都可能表现为 wheel 事件，不能仅凭设备类型判断；以 `ctrlKey/metaKey` 作为当前产品契约。

### 3.3 把渲染生命周期和 Panzoom 生命周期绑在一起

Mermaid render 是异步的，Panzoom 必须等 SVG 已插入 DOM 后再初始化。组件更新或卸载时要同时处理：

- 用 cancellation flag 丢弃过期 Mermaid render 结果。
- 每次新的 `svgContent` 或全屏模式生成新画布控制器。
- 移除 wheel listener。
- 调用 `panzoom.destroy()` 并清空 ref。

否则常见结果是旧控制器继续消费事件、工具栏命令打到已销毁实例，或者主题切换后存在两层 transform。

### 3.4 静态预览与全屏分离

内联预览不拥有 Panzoom。Modal 中创建独立全屏画布，不把同一 DOM/WebView 节点搬入 Modal；关闭销毁全屏控制器，保留预览与聊天位置。

全屏状态需要同时传入：

- React Native surface：独立圆角画布；外层按 safe area 给顶部按钮与底部缩放条预留空间
- Web DOM：viewport填满画布，scene与SVG为原图尺寸，由Panzoom按fitScale适配
- Native HTML：body padding 从 16px 切为 0
- Modal：状态栏和导航栏 translucent，外层使用 Unistyles safe-area insets

只修改其中一层，通常会出现“Modal 已全屏，但图仍按内联高度排版”或四周残留卡片边距。

## 4. 主题与安全

Mermaid 只使用 `createMermaidThemeConfig(theme)` 生成的语义色：`surface`、`surfaceHigh`、`surfaceHighest`、`surfacePressed`、`divider`、`text` 和 `textSecondary`。不要在 SVG 后处理或组件样式里硬编码某个主题包的颜色。

主题变化会生成新 config 并重新 render Mermaid。至少验证一个浅色主题和一个非默认深色主题，节点、连线、文字、edge label 和容器背景都要变化。

Native HTML 不能直接插入用户 Mermaid 源码或主题 JSON。必须通过 `serializeForInlineScript()`，它在 `JSON.stringify` 后转义 `<`、`>`、`&`，避免内容提前结束 `<script>`。Web 端使用 Mermaid 生成的 SVG；不要绕过 Mermaid 的安全配置接收任意 HTML。

## 5. 已踩坑：症状到根因

| 症状 | 容易误判 | 已验证根因 | 正确处理 |
| --- | --- | --- | --- |
| 触控板双指滚动时页面滚动且图表也缩放 | 全局手势冲突 | 无条件调用 `zoomWithWheel` | 普通 wheel 归页面，仅修饰键 wheel 交给 Panzoom |
| 默认比例按住无法拖动，放大后偶尔可以 | pointer/mouse handler 没绑定 | `contain: 'outside'` 在内容已适配时夹住位移 | 移除该 containment，并以默认比例拖拽作为回归用例 |
| 图表抢走整个聊天页滚动 | `touch-action` 单独导致 | wheel handler 调用 Panzoom 后阻止默认滚动 | 分离 touch/pointer 与 wheel 的所有权，不调用普通 wheel 分支 |
| 控制按钮与图形重叠或离开视口 | 单纯放大Modal | 未给独立顶部操作区、底部缩放条和safe area预留空间 | 画布、顶部操作和底部缩放条分别布局 |
| 全屏按钮控制了错误的画布 | ref 更新慢 | 内联和全屏共享控制器 | 两个 canvas ref、两个生命周期、各自的 toolbar target |
| 多张图偶发覆盖或 render 冲突 | React key 问题 | Web 文档内复用了 Mermaid render id | 使用时间戳 + 单调计数器生成唯一 id |
| Native 图表一直空白且不进入错误态 | Mermaid 语法错误 | 外部脚本在 bootstrap 之前阻塞或加载失败，`try/catch` 尚未开始 | CDN 加载策略必须有超时/回退，并在加载阶段就建立错误上报；当前主线仍需继续强化这一点 |
| 内容包含 `</script>` 一类文本时 HTML 被截断 | Mermaid parser 问题 | 原始内容直接插入 inline script | 只使用 `serializeForInlineScript()` |
| 深色主题仍出现默认暖色表面 | Mermaid 配色不全 | 绕过语义 token 或遗漏 theme variable | 统一从 `createMermaidThemeConfig()` 映射，并做深色主题断言 |

## 6. Native 当前限制

当前 Native HTML 使用固定版本的远程 Mermaid/Panzoom 脚本。它有两个需要提前意识到的运行风险：

1. npm/Web 与 WebView CDN 版本可能漂移；升级任一侧时要同步核对两条链。
2. 如果 `<script src>` 在 bootstrap 前阻塞，页面内的 render `try/catch` 无法捕获加载失败。

后续增强 CDN timeout、fallback 或离线资源时，不能只验证“脚本 URL 可访问”；还要覆盖首选源卡住、首选源失败、备选源成功、全部失败可见错误，以及卸载后不会继续回调。

## 7. 回归矩阵

修改 Mermaid、Panzoom、容器布局、消息滚动或 Modal 行为后，至少完成以下检查：

| 层级 | 必测项 |
| --- | --- |
| Web unit | 无 `contain: 'outside'`；普通 wheel 不调用 zoom；Ctrl/Command wheel 调用 zoom；销毁时移除 listener 并 destroy |
| Native unit | 内联禁止命中和滚动、全屏开启 `scrollEnabled`/`nestedScrollEnabled`；全屏 body padding=0；Modal translucent；safe-area padding；比例与下载消息桥接 |
| Model unit | 主题 token 映射；`reset/zoomIn/zoomOut` 命令；inline-script 转义 |
| PC E2E | 长图/横图图片解码、自然比例和顶部对齐；实际节点字号≈正文16px，图框按内容收紧、480px/60vh限高裁切；宽图不缩字而裁切、徽标不遮内容；窄屏仍按宽度适配和70vh限高；内联普通 wheel 页面可滚；点击/键盘进入全屏；全屏拖拽/reset/按钮及修饰键缩放；全屏几何与关闭恢复 |
| 手工触控板 | 内联双指滚动只滚页面；全屏按下拖动图表；浏览器缩放手势不与页面滚动双触发 |
| Native 真机 | 内联滚动归聊天、点击打开；全屏单指拖动/双指缩放/安全区/返回键关闭；弱网/断网错误态 |

推荐命令：

```bash
pnpm --filter happy-app exec vitest run \
  sources/components/markdown/mermaidRendererModel.test.ts \
  sources/components/markdown/MermaidRenderer.test.tsx \
  sources/components/markdown/MermaidRenderer.native.test.tsx

pnpm --filter happy-app typecheck

# 需要已启动且已认证的 Web E2E 环境；不要为普通静态检查擅自启动服务。
HAPPY_E2E_WEB_URL=<authenticated-url> \
pnpm --filter happy-app exec playwright test e2e/mermaid-diagram-interactions.spec.ts
```

## 8. 变更与发布检查单

- [ ] 没有把普通 wheel 重新交给 Panzoom。
- [ ] 默认比例拖拽仍有效，没有恢复会夹住位移的 containment。
- [ ] listener、Panzoom 实例和异步 render 都有对称清理。
- [ ] 桌面内联保持正文大小、紧凑图框，窄屏保留宽度适配；顶部对齐、超出裁切，只有全屏初始化控制器。
- [ ] Web 和 Native 的尺寸、主题、命令与错误态都同步评估。
- [ ] Native inline script 仍通过安全序列化。
- [ ] 依赖版本变更同时核对 npm lock 与 WebView 固定版本。
- [ ] PC 可见交互变更按根 CLAUDE.md 记录截图需求，仅在用户要求时提供前后证据。
- [ ] 合并后分别核对 Web production workflow 和 OTA compatibility/publish 结果；依赖或 lockfile 变化可能让 OTA 安全分类器跳过发布，即使 Web 已成功上线。

## 9. 设计原则

这个组件最重要的边界不是某个 Panzoom 参数，而是手势所有权：页面拥有普通滚动，图表拥有明确的拖拽与缩放意图。任何“让所有 wheel/touch 都由画布接管”的简化，都会在嵌套聊天滚动、触控板或移动 WebView 上重新制造冲突。
