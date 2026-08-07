# Happy PC/Web 右栏与文件切换动效设计

日期：2026-08-07
状态：已批准，待实施计划

## 1. 背景

Happy 的 PC/Web 桌面工作区已经具备左右侧栏展开、收起动效，但侧栏内部和主工作区的文件相关切换仍是瞬时替换：

- 右侧主标签「能力」与「文件」切换时，整个内容树立即跳变。
- 文件侧栏「更改」与「所有文件」切换时，搜索栏、空状态和文件树立即跳变。
- 主工作区在聊天、Diff 和文件预览之间前进、后退时，覆盖层立即出现或消失。

这些跳变让已经平滑的侧栏框架和内部内容产生割裂感，也削弱了前进、后退的空间方向提示。本设计为这三类切换建立同一套轻量 Presence 动效，不改变现有信息架构和业务行为。

## 2. 目标与非目标

### 2.1 目标

1. 让右栏主标签、文件子标签和工作区历史切换具有一致、克制的方向感。
2. 动效只使用合成器友好的 `transform` 和 `opacity`，不触发布局尺寸插值。
3. 快速连续切换时没有闪烁、空白、重复交互层或无限累积的旧视图。
4. 退出视图立即离开指针和无障碍交互，只保留短暂的视觉退场。
5. 尊重 `prefers-reduced-motion`，并维持当前原生端行为不变。
6. 用可重复的 PC Web E2E 证据验证中间帧、方向、时长和回归情况。

### 2.2 非目标

- 不改变左右侧栏宽度、拖拽调整尺寸或展开/收起逻辑。
- 不为移动端、原生 Mac 界面或手势面板新增此 Presence 动效。
- 不改变文件列表的数据请求、缓存、排序、筛选或错误处理。
- 不重做文件行、目录展开箭头、搜索输入框等微交互。
- 不引入路由级页面转场或浏览器 View Transitions API。
- 不保证标签离开后保留当前实现没有保留的滚动位置、搜索词或局部组件状态。
- 不复制或重新挂载聊天消息树；聊天始终作为主工作区的稳定底层。

## 3. 可见验收用例

| Case ID | 场景 | 预期方向与结果 |
| --- | --- | --- |
| `PC-MOTION-06` | 右栏「能力」↔「文件」主标签 | 向右选择后一项时内容向左推进，返回前一项时反向；标签选中态同步柔和过渡。 |
| `PC-MOTION-07` | 文件侧栏「更改」↔「所有文件」子标签 | 搜索区、空状态或文件树作为一个内容面整体转场；标题和统计区域不发生布局抖动。 |
| `PC-MOTION-08` | 主工作区聊天 ↔ Diff ↔ 文件预览的 push/back/forward | push/forward 使用前进方向，back 使用返回方向；回到聊天时仅覆盖层退场，聊天树不重新挂载。 |

## 4. 方案选择

采用可复用的轻量 Presence Host：状态键变化时，暂时同时保留一个退出层和一个进入层，完成 150ms 的交叉淡化与水平位移后清理退出层。

没有采用以下方案：

- **仅入场动画**：实现更小，但旧内容瞬间消失，仍会出现空白或跳切，方向感较弱。
- **View Transitions API**：截图式转场更完整，但浏览器支持、React Native Web 集成、可访问性和快速切换控制成本都更高，不适合本轮局部优化。

## 5. 交互与动效规格

### 5.1 内容面转场

统一参数：

| 属性 | 进入层 | 退出层 |
| --- | --- | --- |
| 时长 | 150ms | 150ms |
| 透明度 | `0 → 1` | `1 → 0` |
| 位移 | 前进时 `translateX(8px) → 0`；返回时 `-8px → 0` | 前进时 `0 → -8px`；返回时 `0 → 8px` |
| 缓动 | `cubic-bezier(0.22, 1, 0.36, 1)` | `cubic-bezier(0.4, 0, 1, 1)` |
| 可交互性 | 当前进入层可交互 | 状态切换当帧即禁用 |

规则：

- 只允许 `transform` 和 `opacity` 参与内容面动画。
- Host 自身维持 `flex: 1`、`min-height: 0` 和稳定边界；两个视觉层使用绝对定位叠放，不插值宽高。
- 稳定态只存在一个内容层。转场态最多存在两个内容层。
- 同一标签被再次点击时不创建新转场。
- 动效结束由 `transitionend` 收尾，并设置略大于 150ms 的兜底计时器，避免事件丢失后残留旧层。

### 5.2 标签选中态

右栏主标签和文件子标签保留现有 pill 结构，不增加滑动下划线。选中背景、文字和图标颜色使用 120ms 的颜色过渡，与内容层同一时刻启动。

选中态先作为真实状态更新，因此键盘焦点、`aria-selected` 和屏幕阅读器反馈不等待视觉动画完成。

### 5.3 前进与返回方向

- 右栏主标签顺序固定为「能力 = 0、文件 = 1」。新索引更大为前进，更小为返回。
- 文件子标签顺序固定为「更改 = 0、所有文件 = 1」。新索引更大为前进，更小为返回。
- 工作区历史的 push 和 forward 为前进，back 为返回。
- 因屏幕变窄、能力关闭或会话失效触发的强制重置直接清理覆盖层，不播放导航转场。

### 5.4 Reduced Motion

当 `prefers-reduced-motion: reduce` 生效时：

- 内容键变化后立即只保留新层，不设置中间位移或透明度。
- 标签颜色立即更新。
- 退出层不等待计时器或 `transitionend`。
- 所有业务状态、焦点和可访问性语义与普通模式一致。

## 6. 组件设计

### 6.1 `DesktopPresenceTransition`

新增一组同名平台文件：

- `sources/components/DesktopPresenceTransition.web.tsx`：实现 Web Presence 生命周期与 CSS 数据属性。
- `sources/components/DesktopPresenceTransition.tsx`：原生端透传当前 children，不增加动效和历史层。

建议接口：

```ts
type DesktopTransitionDirection = 'forward' | 'back';

type DesktopPresenceTransitionProps = {
    children: React.ReactNode | null;
    direction: DesktopTransitionDirection;
    testID: string;
    transitionKey: string;
};
```

Web Host 内部保存：

- 当前活动层：`key`、`node`、`direction`、`phase`。
- 可选退出层：上一个活动层的冻结 ReactNode 快照。
- Reduced Motion 查询结果。
- 转场序号，用于忽略旧计时器和旧 `transitionend`。

生命周期：

1. 首次渲染直接建立一个 `settled` 层；`children === null` 时保持空 Host。
2. `transitionKey` 改变时，把当前活动层转为 `exiting`，并用最新 children 建立 `entering` 层。
3. 下一绘制帧把进入层切到 `settled` 视觉值，触发 CSS transition。
4. 动效完成后删除退出层，只保留活动层。
5. 转场中再次切换时，立即丢弃更早的退出层；当时最新的活动层成为唯一退出层，新 children 成为进入层，因此 DOM 中最多两个内容层。
6. `children` 从内容变为 `null` 时仍允许当前层完成退场；`null` 不是可交互层。
7. `children` 从 `null` 变为内容时仅创建进入层，底层已有的聊天视图保持不动。

Web 层通过 `data-happy-presence-phase` 和 `data-happy-presence-direction` 驱动 `theme.css`。不使用 JavaScript 逐帧更新样式。

### 6.2 交互和无障碍隔离

退出层从状态切换当帧开始：

- `pointerEvents="none"`
- `aria-hidden="true"`
- `accessibilityElementsHidden={true}`
- `importantForAccessibility="no-hide-descendants"`

进入层是唯一可交互、可聚焦和可被屏幕阅读器读取的层。Host 不自动抢焦点：

- 点击标签后焦点留在该标签按钮。
- 通过侧栏导航按钮进入 Diff/文件时，焦点留在触发导航的控件。
- 当前页面已有的显式焦点逻辑继续生效。
- 150ms 重叠期内不得出现重复 tab stop 或重复语义节点。

## 7. 集成点

### 7.1 右栏主标签

在 `SessionView.tsx` 中，用 `DesktopPresenceTransition` 包裹 `DesktopRightPanel` 的 children：

- `transitionKey` 使用 `desktopPanelMode`。
- 根据固定标签索引计算 forward/back。
- `canShowFilePanel` 失效并强制回到能力面板时直接清理，不保留不可用的文件层。
- `SessionRightPanelContent` 和 `FilesSidebar` 只在最多 150ms 的转场窗口内短暂并存。

在 `DesktopRightPanel.tsx` 给标签增加稳定的数据属性，供 `theme.css` 实现 120ms 的背景、文字和图标颜色过渡。标签几何尺寸不动画。

### 7.2 文件侧栏子标签

在 `FilesSidebar.tsx` 中保留现有 header 和统计区，只用 Presence Host 包裹条件内容：

- changes 层包含现有 changes `ScrollView`。
- allFiles 层包含现有 `AllFilesTab`。
- `transitionKey` 使用 `mode`，方向按固定顺序计算。
- header 高度、tab row 和统计位置保持稳定，避免整个右栏上下抖动。

子标签选中背景和文字颜色使用与主标签相同的 120ms 颜色过渡。

### 7.3 主工作区历史

在 `SessionView.tsx` 现有聊天内容上方增加一个绝对定位的 Presence Host，只管理覆盖层：

- `none/chat` 对应 `children = null`，不会复制或卸载聊天树。
- `diff` 层渲染 `AllFilesDiffView`。
- `file` 层渲染 `FileViewPanel`。
- `transitionKey` 包含类型和资源标识，例如 `diff:${file}`、`file:${path}`；切换到不同文件也能获得明确的新内容层。
- overlay history 同时记录本次动作的方向：push/forward 为 forward，back 为 back。
- Header 继续是稳定的工作区 chrome；标题与右侧操作槽按最新活动状态立即更新，不复制 header。

## 8. 性能与稳定性约束

- DOM 中每个 Host 最多两个内容层，稳定态必须回到一个层。
- 旧文件树、Diff 或文件查看器最多额外存活 150ms，不做长期 `display:none` 缓存。
- 不复制聊天消息树，不对侧栏宽度、高度、列表行高或滚动位置做动画。
- Presence 层使用 `will-change: transform, opacity`，动画结束后不继续进行 JavaScript 工作。
- Host 使用布局/绘制隔离时不得裁切现有焦点环、滚动条或右栏 resize handle。
- 快速切换时所有旧回调由转场序号失效，不能误删最新活动层。
- 组件卸载时清除 requestAnimationFrame、媒体查询监听和兜底计时器。

## 9. 测试与视觉验收

### 9.1 单元与组件测试

为 Presence Host 添加 Web 定向测试：

- 首次渲染只有一个 settled 层。
- key 改变时存在一个 entering 和一个 exiting 层。
- exiting 层立即禁用指针并从无障碍树隐藏。
- transitionend/兜底计时后只保留当前层。
- 快速连续切换始终不超过两个层，过期回调不删除最新层。
- forward/back 产生相反方向数据属性。
- Reduced Motion 下立即切换且没有重叠层。
- null ↔ 内容覆盖聊天场景正确入场和退场。

补充现有组件测试：

- `DesktopRightPanel` 和 `FilesSidebar` 的标签仍有正确 `tab` 角色、选中态和点击行为。
- `SessionView` 的 push/back/forward 继续选择正确的 Diff 或文件内容。
- 强制关闭文件能力时清空 overlay，不遗留动画层。

### 9.2 E2E 场景

在 Chromium 桌面视口至少覆盖 `1280×720` 和 `1920×1080`：

1. `PC-MOTION-06`：能力 → 文件 → 能力；捕获起点、中间帧和终点，验证方向与 150ms 内收敛。
2. `PC-MOTION-07`：更改 → 所有文件 → 更改；验证 header 不跳、搜索/文件树整体转场。
3. `PC-MOTION-08`：聊天 → Diff → 文件，随后 back、forward；验证前进/返回方向相反，聊天 DOM 身份不变。
4. 每组加入快速往返点击，断言 Presence layer 数量始终 `<= 2`，结束后为 `0` 或 `1` 个可见内容层。
5. 键盘导航时断言焦点仍在最新触发控件，退出层无可聚焦元素。
6. Reduced Motion 模拟下断言直接进入稳定态。

每个可见 Case 保存同视口、同 DPR 的 before/after 对照和 25fps 左右的短录屏。验收记录同时报告：

- `console.error` 增量
- 未捕获 page error 增量
- 非预期失败请求增量
- 测试重试次数

三项运行时错误增量必须为 0，关键 E2E 不依赖重试通过。

### 9.3 静态验证

实施完成后运行：

- Happy App typecheck
- 相关单元/组件测试
- PC Web motion E2E
- Web export/build
- diff hygiene 与工作树检查

## 10. 验收清单

- [ ] 三个 Case 的前进、返回方向一致且易辨认。
- [ ] 内容转场 150ms，位移 8px，只使用 transform/opacity。
- [ ] 标签选中态 120ms，不改变布局尺寸。
- [ ] 快速切换期间每个 Host 最多两个视觉层，最终只剩当前层。
- [ ] 退出层从切换当帧起不可点击、不可聚焦、不可被屏幕阅读器读取。
- [ ] Reduced Motion 无过渡、无残留计时器、无重叠层。
- [ ] 聊天树在聊天 ↔ Diff/文件切换时保持挂载。
- [ ] 两个桌面视口的 before/after 证据齐全。
- [ ] Console、page error、非预期失败请求增量均为 0。
- [ ] 原生端和现有数据行为没有变化。

## 11. 风险与缓解

| 风险 | 缓解 |
| --- | --- |
| 大型文件树或 Diff 短时双份渲染 | 重叠严格限制为 150ms、最多两层；不缓存第三层或后台视图。 |
| 快速点击导致旧计时器误删新内容 | 每次转场递增序号，回调只处理自身序号；新切换先丢弃更老退出层。 |
| 两层同时响应鼠标或键盘 | 退出层当帧禁用 pointer events，并从无障碍树隐藏。 |
| 绝对定位破坏滚动或测量 | Host 占满已有 flex 内容区，仅内部层绝对定位；header 和 panel 尺寸仍由原布局决定。 |
| Reduced Motion 仍短暂出现重叠 | 媒体查询在建立过渡前决定路径，reduce 模式同步替换活动层。 |
| 文件覆盖层退场时 header 已切回聊天 | 接受 header 作为最新导航状态立即更新；150ms 仅用于内容空间连续性，避免复制交互 chrome。 |
