# 主题与视觉基础规范

适用于 Paws 自有 App 的新页面、组件、改版和评审。规则覆盖 PC Web 与原生移动端，但平台布局、键盘/触控和验收分别判断；本次整理不改变运行代码，也不声明所有历史组件已完成迁移。

## 1. 设计变量的事实源

| 角色 | 源码 | 使用边界 |
| --- | --- | --- |
| 完整基础主题、语义颜色与共用尺寸 | [`theme.ts`](../../packages/happy-app/sources/theme.ts) | light/dark 与 `Theme` 类型；组件消费当前主题，不直接取某个基础主题对象 |
| 主题包的 light/dark 配色输入 | [`themePacksData.ts`](../../packages/happy-app/sources/themePacksData.ts) | 定义主题包角色，不由普通组件直接挑色 |
| 主题包→完整主题的映射 | [`themePacks.ts`](../../packages/happy-app/sources/themePacks.ts) | `applyAccent`、`appThemes`、主题名称解析；保留功能色与交互层级 |
| 当前主题注册与切换 | [`unistyles.ts`](../../packages/happy-app/sources/unistyles.ts) | 当前平台/设置/皮肤生效规则；组件不得维护第二套主题选择逻辑 |
| PC 照片皮肤及其层级 | [`desktopSkin.ts`](../../packages/happy-app/sources/desktopSkin.ts) | 照片上的对比、透明度和减少透明度回退；不等于在任意组件设置透明背景 |
| 字体与字重 | [`Typography.ts`](../../packages/happy-app/sources/constants/Typography.ts) | 默认正文、等宽、品牌与展示字体各有用途 |
| 内容宽度 | [`layout.ts`](../../packages/happy-app/sources/components/layout.ts) 与所属工作区布局 | 普通页面复用 maxWidth/headerMaxWidth；桌面多栏按实际容器约束，不另写一套全局宽度 |

`theme.gen.ts` 当前只生成 `theme.light.json` / `theme.dark.json`；它不是完整 `theme.ts` 或当前主题包的生成入口。不要为改一个组件运行它并误以为已更新产品主题。

## 2. 颜色按用途取值

在 `StyleSheet.create(theme => ...)` 或 `useUnistyles()` 提供的当前 `theme` 上取值。禁止在普通组件中导入 `lightTheme`、`darkTheme` 或 `appThemes.caramelLight` 来绕过当前主题；测试与主题基础设施可按职责使用这些对象。

下表是角色导航，不是完整 token 清单；准确名称与类型以源码为准。

| 界面用途 | 当前语义变量 | 注意 |
| --- | --- | --- |
| 普通表面/卡片/列表项 | `colors.surface` | 不用页面背景假装按下或选中态 |
| hover / pressed 表面 | `colors.surfacePressed` | 鼠标悬停与按下都应可见，不能残留默认暖色 |
| selected / active 表面 | `colors.surfaceSelected` | 选中与 hover 可区分；组合状态沿所属通用组件的优先级 |
| 更高表面层级 | `colors.surfaceHigh` / `surfaceHighest` | 表示层级，不任意代替交互状态语义 |
| 正文/次要文字/链接 | `colors.text` / `textSecondary` / `textLink` | 不把次要文字淡化到不可读；主要动作不能仅靠链接颜色辨认 |
| 页面分组背景 | `colors.groupped.background` | `groupped` 是源码现有拼写，不擅自创建 `colors.background` 或另一个同义对象 |
| Header 背景/内容 | `colors.header.background` / `header.tint` | 标题、图标也要跟随当前主题 |
| 输入框 | `colors.input.background` / `text` / `placeholder` | 占位提示不代替可见标签 |
| 边线/阴影/遮罩 | `colors.divider`、`shadow.color/opacity`、`modal.backdrop/border` | 不在组件写死黑白阴影或蒙版色；透明容器的事件边界另按浮层规范 |
| 通用主按钮 | `colors.button.primary.*` | 消费已有按钮组件的行为；不能猜一个源码中不存在的 pressed token |
| 危险按钮与危险文字 | `colors.button.destructive.*`、`textDestructive` / `deleteAction` | 按已有组件和语义选择，不用主题强调色掩盖危险性 |
| 连接/错误等状态 | `colors.status.*`，以及对应功能域 token | 成功/错误/离线必须有文字或图标等价信息，不只靠变色 |
| 照片上的操作控件 | `colors.imageOverlay.*` | 背景和前景成对使用，确保在照片明暗变化下可读 |
| 桌面皮肤各栏 | `colors.desktopSkin.*` 与工作区已有表面上下文 | 按所在栏及减少透明度状态处理，不把全页变成统一透明层 |
| 代码、diff、终端 | 已有 `colors.syntax*`、`diff.*`、`terminal.*` | 功能含义优先；不要把所有语法/状态色机械改成品牌色 |

允许完全透明的布局容器表达结构。`transparent` 不应被用来省略必要的 hover/selected 背景。固定品牌资产、图片原色和明确不可主题化的内容色可例外，但须说明用途和对比度策略；“示例里就是这个 hex”不是例外理由。

需要派生透明色时，先查现有角色及 [`colorOpacity.ts`](../../packages/happy-app/sources/utils/colorOpacity.ts) 等共用方法；不要追加只适用于 hex 的字符串后缀，也不要在组件散布一组新的 RGBA 常量。

## 3. 交互状态也属于主题

| 状态 | 必须明确的表现与行为 |
| --- | --- |
| normal | 当前主题的普通表面、正文、图标和边线 |
| hover / pressed | 使用对应交互表面；不以 hover 作为关键动作的唯一可见入口 |
| selected / active | 选中表面及语义状态；hover 选中项时仍能识别选中 |
| keyboard focus | 可见焦点指示，沿用所属组件的样式与 `textLink` 等现有角色；不能只声明 focused 状态却没有视觉反馈 |
| disabled | 无法执行动作且语义暴露 disabled；不能仅降低透明度仍允许点击 |
| busy / loading | 反馈进行中并防止重复提交；已有选择不因目录暂未到达被清空 |
| empty / error / offline | 区分没有数据、加载失败和不可连接，提供当前真正可用的下一步 |
| drag-over | 保留明确目标反馈；结束、取消、卸载后清理，不遗留激活表面 |

`surfaceSelected` 与 `surfacePressed` 的叠加顺序由组件统一定义，不能要求所有按钮都简单用同一条数组顺序。新增状态应复用或扩展对应组件，并在普通、选中+hover、选中+focus 等实际组合下检查。

## 4. 新增或调整 token 的流程

1. 先说清颜色的语义角色和现有角色为什么不适用；同一用途不能因为页面不同就新增一套名字。
2. 在 `theme.ts` 的 light/dark 中完整定义，保持 `Theme` 类型约束；不把新变量只塞进一个组件或一个主题包。
3. 若角色需要跟随主题包，维护 `themePacksData.ts` 的对应输入及 `themePacks.ts` 的映射。当前必须保留 `surfacePressed ← surfaceHigh`、`surfaceSelected ← surfaceHighest`；新增角色需要自己的合理映射，不能全都继承默认主题色。
4. 检查照片皮肤覆盖、主题切换、减少透明度和相关 Web 初始背景。不要只验证静态默认主题对象。
5. 修改组件消费位置并补必要的映射/状态回归；至少覆盖一个非默认深色主题，优先 `ginghamDark`。

并非每个主题包都应独立覆盖全部功能色：语法、diff、终端及错误等功能角色可按当前系统继承基础明暗态。判断依据是语义和对比度，不是“所有颜色都必须等于主色”。

## 5. 排版、密度与布局

- 正文与界面文字用 `Typography.default()` / `body()` / `header()`；代码、命令和适合等宽阅读的路径用 `Typography.mono()`。Web 默认是系统 UI 字体栈，原生沿用打包字体，不从注释或旧截图推断两端相同。
- `Typography.logo()` 和 `display()` 属品牌/展示用途，不替代长正文。Fredoka 仅有拉丁字形，中文会回退，必须检查中英混排；不可把中文回退误当作同一字体已覆盖。
- 优先沿用原页面/通用组件的字号、行高和信息密度。当前没有一份覆盖所有组件的统一字号 token 表，不虚构全站字号阶梯；出现重复稳定角色后再向公共类型系统收敛。
- 尺寸优先查当前主题的 `margins`、`borderRadius`、`iconSize`。现有名字是 `theme.margins.md` 等，不是不存在的 `theme.spacing.md`。具体值以 `theme.ts` 为准，本文不手抄另一份尺度。
- 图标 glyph 尺寸、按钮视觉大小与可点击区域分别检查。不能用缩小文字/图标修补布局，也不能因写了 hitSlop 就断言触控范围有效；祖先裁切、相邻按钮和真实设备命中需另验。
- 长标题、最长模型名、翻译、多位数量和空状态都应检查；使用实际容器宽度、minWidth/flexShrink/省略和滚动策略，避免写死大宽度后让边缘控件不可达。
- PC 多栏应能独立收起、回收空间和恢复；不能把移动布局简单拉宽，或把 PC 多栏压进手机。滚动/折叠/返回时保留任务上下文。
- 动画与照片透明度尊重系统减少动态/透明度设置。装饰不代替运行状态，不能仅靠动效告诉用户任务是否还在执行。

## 6. 优先复用的入口

| 场景 | 先查现有实现 | 边界 |
| --- | --- | --- |
| 设置列表/分组 | `Item` / `ItemGroup` | 复用标题、说明、分隔、危险/禁用语义，不临时拼另一套设置行 |
| 项目工作区操作 | `GoalBoardButton` / `ProjectSurfaces` | 项目范围的组件与上下文，不直接推广为全产品万能按钮 |
| 常规按钮 | `RoundButton` 及所在页面已有按钮 | 检查 variant、busy/disabled、键盘焦点及主题能力后复用，不因名字相似就盲套 |
| 对话框与浮层 | 已有 Modal 宿主、`DesktopDialogFrame`、`useWebPopoverDismiss` | 遵循[浮层规范](overlay-interaction-standard.md)；Hook 不能代替焦点与层级管理 |
| Tooltip | `DesktopShortcutTooltip` / `ComposerTooltipHost` 等现有入口 | 只承载辅助说明；布局裁切与 Portal 所有者要验证 |
| 普通页面与多栏 | `layout` 与所属 workspace 的布局/宽度上下文 | 不复制全局断点或桌面宽度偏好逻辑到局部组件 |

复用之前检查当前能力、调用处与测试。发现组件有缺口时优先在合理的公共层修复，不能把“代码里已有”写成“已经完全符合规范”。

## 7. 最小验收与记录

1. 主题：至少检查明暗态及一个非默认深色主题；修改映射时补非默认主题回归。涉及照片/图片控件，再检查照片皮肤及减少透明度回退。
2. 状态：检查 normal、hover/pressed、selected 和键盘焦点；按改动补 disabled/busy/error/offline/drag-over，不只截正常静态状态。
3. 布局：按目标平台检查代表性宽度、长内容和实际操作路径；主按钮、关闭、错误恢复始终可达。
4. 行为：点击、键盘、触控按受影响平台分别验证；类型检查不能证明颜色对比、原生触达或真实焦点行为。
5. 回归入口：[`themePacks.test.ts`](../../packages/happy-app/sources/themePacks.test.ts)、[`Typography.test.ts`](../../packages/happy-app/sources/constants/Typography.test.ts) 与受影响组件测试；选择与改动相称的检查，不为纯文档更新重复跑整站。
6. 截图/视频按根 CLAUDE.md 的当前要求；报告“源码确认、测试通过、真实页面验证、用户设备已加载”各自的范围，不互相替代。

常见复发错误应回写原规则：默认暖色残留先查主题映射；照片按钮看不清先查前景/背景配对；英文好看中文失配先查字体覆盖；按钮被挤掉先查布局和容器，而不是继续缩字。具体故障证据归 validation，规范保存稳定方法。
