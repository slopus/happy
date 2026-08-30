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

- 鼠标或触控板按住画布后，默认缩放比例也必须能够拖动画布。
- 普通鼠标滚轮、触控板双指滚动属于页面，不能缩放图表，也不能被图表阻止。
- `Ctrl/Command + wheel` 才交给 Panzoom 缩放；工具栏的放大、缩小、重置始终可用。
- 打开全屏会创建独立画布实例；关闭后内联画布仍可继续使用。
- 全屏内容必须落在可视区域内，表面不能保留内联卡片的圆角或边框。

### Native/WebView

- WebView 必须允许内部滚动并参与父级嵌套滚动：`scrollEnabled` 与 `nestedScrollEnabled` 保持开启。
- 全屏 HTML 不保留内联模式的 16px body padding。
- Modal 同时处理状态栏、导航栏和安全区；全屏表面无圆角、无边框。
- 缩放、拖拽和重置由 WebView 内的 Panzoom 完成，React Native 工具栏只发送命令。

## 3. 推荐实现结构

### 3.1 分开 viewport、scene 和 SVG

Web DOM 层级保持为：

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
    minScale: 0.5,
    maxScale: 5,
    step: 0.25,
});
```

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

### 3.4 内联与全屏使用独立实例

内联画布和 Modal 中的全屏画布各自拥有 ref。不要把同一 DOM/WebView 节点搬入 Modal，也不要让两个工具栏共享一个 Panzoom ref。

全屏状态需要同时传入：

- React Native surface：`flex: 1`、`borderRadius: 0`、`borderWidth: 0`
- Web DOM：viewport/scene 高度为 `100%`，SVG 高度受全屏容器约束
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
| 全屏仍有圆角、边框或四周留白 | Modal 尺寸不够 | 复用了内联 surface 和 Native body padding | 为全屏传递独立样式和 HTML 参数，并处理 safe area |
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
| Native unit | `scrollEnabled`、`nestedScrollEnabled`；全屏 body padding=0；Modal translucent；safe-area padding；全屏无边框圆角 |
| Model unit | 主题 token 映射；`reset/zoomIn/zoomOut` 命令；inline-script 转义 |
| PC E2E | 默认比例拖拽；reset；按钮缩放；普通 wheel 页面可滚且 transform 不变；修饰键 wheel transform 改变；缩放后拖拽；全屏几何和关闭恢复 |
| 手工触控板 | 双指滚动只滚页面；按下拖动图表；浏览器缩放手势不与页面滚动双触发 |
| Native 真机 | 内联嵌套滚动；单指拖动；双指缩放；全屏安全区；返回键关闭；弱网/断网错误态 |

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
- [ ] 内联与全屏没有共享画布 ref。
- [ ] Web 和 Native 的尺寸、主题、命令与错误态都同步评估。
- [ ] Native inline script 仍通过安全序列化。
- [ ] 依赖版本变更同时核对 npm lock 与 WebView 固定版本。
- [ ] PC 可见交互变更按 PR 规则提供逐 Case 前后证据。
- [ ] 合并后分别核对 Web production workflow 和 OTA compatibility/publish 结果；依赖或 lockfile 变化可能让 OTA 安全分类器跳过发布，即使 Web 已成功上线。

## 9. 设计原则

这个组件最重要的边界不是某个 Panzoom 参数，而是手势所有权：页面拥有普通滚动，图表拥有明确的拖拽与缩放意图。任何“让所有 wheel/touch 都由画布接管”的简化，都会在嵌套聊天滚动、触控板或移动 WebView 上重新制造冲突。
