# RareUI GitHub activity 与 Paws 热图集成评估

2026-11-25。已完成参考组件的真实浏览器交互、固定提交源码和许可核对，以及 Paws 当前实现审查。结论：可以承接其卡片与交互设计；建议用 Paws 现有组件独立实现。未安装组件、修改业务代码、发布或部署。

## 原界面与保留边界

- 原来源：用户本会话提供的使用情况截图，以及 main `dd5fce94c1fc2926ec795e0f89bd7d90b4ec4c35` 的 `packages/happy-app/sources/components/usage/UsagePanel.tsx`。
- 截图可见滚动年度日历、月份标签、热度图例及大块日详情；本次源码审查没有启动 Paws 真实页面，不把源码或截图当成真实 Paws 浏览器验收。
- 保留使用情况弹窗、上方账号 quota、机器活动来源及下方 API 用量；改动目标仅为年度活动组件及其日详情。
- 原位技术来源是 React Native/Expo + Unistyles。颜色沿用当前 `surface`、`surfaceHigh`、`accent`、`text`、`textSecondary` 和 `divider`；选中/焦点使用独立边界，不能覆盖热度底色。

## RareUI 实际观察

官方页面：[GitHub activity](https://www.rareui.com/components/githubactivity)。已通过 Ego 真实操作：

1. 从组件目录进入目标组件，阅读参数及许可说明。
2. 点击 Show top repositories，看到展开的三行仓库排名；点击 Hide top repositories 收起。
3. 悬停日期格，读回对应日期及贡献数提示。三个关键结果已通过同一 runId 回传 Happy Skills。

真实预览采用紧凑圆角卡片、约11px方格、3px间隙；底部折叠条展开后覆盖网格。预览标题为2025年贡献数，属于作者固定演示数据，不是当前真实 GitHub 统计。

浏览器已验证的是参考组件的展开/收起/鼠标悬停，不包括 Paws 集成、手机、键盘或所有断点。

## 当前 Paws 为什么显得奇怪

| 现象 | 源码原因 | 改法 |
|---|---|---|
| 网格显大，容器较窄时裁切或强制横滚 | cell min=max=16，gap min=max=4；53周固定占1056px，外加24px | 采用明确的紧凑密度；保留全年可横滚，不因窄屏静默删除早期周 |
| 高用量日期选中后变灰，像空数据 | selected/hover/pressed 覆盖活动底色 | 保留强度底色，用独立外圈表示选中和焦点 |
| 调整窗口或数据更新时跳回最近日期 | onLayout/onContentSizeChange 每次 scrollToEnd | 只首次定位最近日期，其后保留用户滚动位置 |
| 两个“11月”，缺少范围上下文 | 滚动365天跨年，但缺少年份/准确日期范围 | 显示实际起止日期，月份与星期对齐 |
| 悬停看详情需要看下方大卡 | 没有格旁提示；hover直接改整块详情 | 鼠标/键盘聚焦显示短提示；点击固定选中日并展示详情 |
| 键盘操作繁琐 | 每格Pressable，无方向键/单一Tab停靠策略 | 焦点与hover等价，使用方向键逐日/逐周移动，保持可见focus-ring |

已执行纯日期模型：当前窗口为2025-11-26至2026-11-25，365天/53周；日期本身不是月份错位。

## 数据可以直接适配，组件不能无改动安装

RareUI 的自定义输入为 `Contribution { date, count, level: 0|1|2|3|4 }[]`。Paws 已有每日日志汇总，可把 `totalTokens` 映射为热度值；日提示继续拆分非缓存输入、缓存、输出，标明含缓存总量。

不提供 `username`，不调用其 GitHub/第三方贡献 API。原组件同时依赖 HTML、react-dom/createPortal、motion/react、ResizeObserver、Tailwind 及 utils，不能直接在 React Native 上运行。

源码还有需主动修正的边界：自定义数组简单按7天分组，不自动排序补日或对齐星期；响应式策略会隐藏早期周，但标题仍统计全部数据；日格仅支持pointer hover；没有Paws所需的日期选择回调、token formatter和locale。直接换组件仍会留下数据理解和触控问题。

## 建议的具体接入形态

1. 顶部：保留“过去一年的活动”，补准确日期范围和机器级统计说明；使用紧凑图例。
2. 主体：约11–13px的紧凑格子、约3px间隙，月份与星期定位清楚；宽屏完整显示，窄屏横向查看全年。热度、选中和焦点相互独立。
3. 悬停/焦点：格旁显示日期、含缓存总量和会话数；触控点击可得到等价信息。
4. 底部：借鉴 RareUI 的收起/展开层次，将现有大详情改成可展开的“所选日期明细”，展示非缓存输入、缓存、输出。
5. 不照搬作者仓库排名。Paws 当前日汇总没有模型/项目/会话排行明细；该能力需后续请求账本支持，不能用假数据填充。
6. 模型与展示分离：纯 `codexActivityCalendar.ts` 负责日期/强度；Web实现隔离DOM交互；RN实现保留触控。`UsagePanel`仅消费现有快照，不改变quota选择和RPC。

这是可实施方案，尚未制作原型或替换真实组件。验收应覆盖跨年/闰日/时区、约360/768/1280px宽度、深色非默认主题、hover/点击/键盘、滚动保留及减少动态；现有mock RN测试不能替代真实页面验证。

## 许可与一手来源

固定SHA：`0e9f0ef86bd690b16175fb81950ce38a5e689cd4`。

- [组件源码](https://github.com/swamimalode07/rare-ui/blob/0e9f0ef86bd690b16175fb81950ce38a5e689cd4/components/ui/github-activity.tsx)
- [Registry数据](https://github.com/swamimalode07/rare-ui/blob/0e9f0ef86bd690b16175fb81950ce38a5e689cd4/public/r/github-activity.json)
- [LICENSE](https://github.com/swamimalode07/rare-ui/blob/0e9f0ef86bd690b16175fb81950ce38a5e689cd4/LICENSE)

实际许可为 MIT + Commons Clause + Attribution，并非标准MIT。允许作为应用/网站/产品的一部分使用，要求保留版权与许可并提供可发现的Rare UI链接；对组件本身及移植版本的再分发等另有限制。不能把复制部分直接重标为Paws的纯MIT源码，也不能泛称开源应用完全不可使用。

本轮没有复制第三方运行代码。推荐参考其可观察交互独立实现Paws组件；若后续明确选择复制原组件，应独立保留其许可与署名并核对具体分发范围。

## 2026-11-26：v1 缺口与 v2 源码对照

以上内容保留为2026-11-25的参考调研与原界面评估。首轮v1替换虽然完成了紧凑日历、日期明细和部分交互增强，但没有完整承接参考组件的覆盖面板、叠层图标转入指标行、逐列入场、双端减少动态及受控展开合同。因此不能把v1描述为已经完整还原RareUI的交互与动效。

v2重新对照RareUI固定提交 `0e9f0ef86bd690b16175fb81950ce38a5e689cd4`，以Paws现有技术独立补齐以下能力。原组件许可仍为 **MIT + Commons Clause + Attribution**，源码、Registry与LICENSE链接见上节；本次没有复制其运行源码，没有安装RareUI组件，也没有把原组件重新标为Paws的普通MIT代码。参考来源和许可边界继续保留，不以视觉参考代替许可核对。

| 对照项 | v1未覆盖或不足 | v2 Web源码 | v2 Native源码 |
|---|---|---|---|
| 覆盖网格的收展面板 | 仅把日期明细作为普通展开内容，没有参考中的覆盖层次 | 底部摘要属于同一个绝对定位面板；展开时面板覆盖日历区域，网格设为`inert`并退出可访问树，明细内部可滚动；收起恢复日历入口 | `Animated.View`面板在既有区域内平移覆盖日历；展开时禁止底层图表触控并隐藏其可访问内容，明细使用独立`ScrollView` |
| 叠层图标/徽标转为指标行 | 没有摘要叠层到三项明细位置的转换关系 | 三个指标缩写徽标在摘要中叠放；根据摘要锚点和指标行锚点的DOM矩形计算FLIP位移，使用Web Animations API移动同一组徽标，展开与收起均可转换 | 摘要叠放三个Ionicons图标；面板进度控制叠层图标淡出及上移，并让指标行图标与内容淡入及上移。采用两组呈现的交叉过渡，不声称原生实现了DOM FLIP或同节点共享布局 |
| 图表与文字入场 | 没有参考的逐列进入与月份文字过渡 | 周列按列序使用CSS stagger入场，月份标签淡入并解除模糊；指标行标签与数值按行延迟进入 | 采用单个原生驱动进度控制图表整体的轻量淡入/位移，指标行跟随面板进度出现；没有逐列创建动画，也不声称两端入场动效完全相同 |
| 减少动态 | 没有把偏好读取、运行时变化与双端退化作为完整合同 | 读取并监听`prefers-reduced-motion`；减少动态时关闭列入场、CSS过渡、徽标位移及Tooltip动画。另对减少透明度提供实色面板回退 | 使用`AccessibilityInfo`读取并监听减少动态；未知或读取失败时先采用静态状态，运行时事件优先于较晚返回的初始读取；面板与入场进度直接设置为目标值 |
| 受控/非受控收展 | 展开状态只在组件内部，没有可复用的外部状态合同 | 与Native共用`open`、`defaultOpen`、`onOpenChange`及`useActivityDisclosure`；受控模式由父层决定实际开合，非受控模式维护本地状态 | 使用同一props类型与Hook，不另建不同名称或行为的原生合同 |
| 日期提示与退出 | 缺少与收展层次配套的提示呈现与退出行为 | 格旁Tooltip通过Portal定位，鼠标与键盘焦点得到等价日期信息；采用短入退场过渡。Escape先退出提示或明细，焦点回到对应入口，并处理RN Web外层Modal的同次keyup | 不引入DOM Tooltip或Portal；使用日期可访问说明、所选日摘要及明细提供触控和焦点入口，不声称拥有鼠标悬停提示 |

### 延续的数据、日历与平台边界

- 全年保留滚动365个自然日，按快照时区确定结束日期，提供实际范围、月份和星期定位。两端都使用水平滚动查看完整日历，不套用参考组件在窄屏隐藏早期周的策略；首次定位最近日期后，普通快照更新不会反复抢走阅读位置。
- 三项指标使用真实快照计算：非缓存输入为`max(0, inputTokens - cachedInputTokens)`，缓存读取为`cachedInputTokens`，输出为`outputTokens`。另展示原始含缓存总量；reasoning属于输出，不再次相加。没有把仓库排行或贡献数演示数据包装成Paws用量。
- Web保留单一Tab停靠点、方向键逐日/逐周移动、Home/End、焦点提示与独立选中外圈；热度底色不因选中或悬停被替换。Native保留日期格触控和可访问标签，并提供更大的前一天/后一天控制；这些入口不等同于已经通过手机触达验收。
- `UsagePanel`继续提供原有机器活动快照，账号quota及API用量保持原职责。没有提供GitHub用户名，没有接入RareUI的GitHub或第三方贡献API，也没有新增远程排行榜数据请求。
- Web的DOM测量、FLIP、列stagger与Portal隔离于`.web.tsx`。Native使用React Native `Animated`与现有Ionicons，采用整体入场和图标交叉过渡，不导入`react-dom`、`motion/react`或Tailwind。

### v2源码入口与验证状态

- [Web日历、覆盖面板、徽标FLIP与Tooltip](../../packages/happy-app/sources/components/usage/CodexActivityHeatmap.web.tsx)
- [Native日历、覆盖面板与轻量动画](../../packages/happy-app/sources/components/usage/CodexActivityHeatmap.tsx)
- [共用props合同](../../packages/happy-app/sources/components/usage/CodexActivityHeatmap.types.ts)、[展开状态Hook](../../packages/happy-app/sources/components/usage/useActivityDisclosure.ts)
- [日期模型](../../packages/happy-app/sources/components/usage/codexActivityCalendar.ts)、[尺寸、月份与真实指标映射](../../packages/happy-app/sources/components/usage/activityPresentation.ts)

本节仅记录当前v2源码与参考的对应关系，不预填v2测试、构建或浏览器通过结果；这些结果由父任务完成后写入[功能验收记录](codex-usage-activity.md)。上文RareUI参考页的浏览器证据及v1的历史验收不能替代v2验收。原生真机尚未验证；原生源码或组件测试不得表述为用户手机已经可用。
