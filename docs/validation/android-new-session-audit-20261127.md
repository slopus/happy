# Android 新建会话流程诊断

日期：2026-11-27。源码基线：`4c5ed47f180b473204d13d0f4938066715260e26`。

本轮目标是先定位问题与验收缺口，未修复或发布产品。输入证据为用户本轮提供的两张 Android 截图；没有从其他附件猜测截图。截图没有提供 APK 包名、OTA Update ID、手机型号、系统字号或键盘状态，不能直接认定截图版本等于当前 main。

## 当前结论

新建流程同时存在布局预算、能力目录、交互入口、可读性和验收覆盖缺口。不能仅缩小字、移动一个浮层或通过 Web 回归就判定整套流程修好。

证据分为用户截图、当前源码、自动化测试、Android 模拟器和用户真机。各层分别记录；截图能确认现象，源码能定位缺陷或形成假设，模拟器不能代替用户设备验收。

## 问题清单

| 编号 / 优先级 | 现象和代码证据 | 判定与修复方向 |
| --- | --- | --- |
| A1 / P1 | 长模型标签挤压附件、权限和发送区。`MessageComposer.tsx:219` 左组 `flex:1`，原生 `overflow:hidden`；`:251` 右组不收缩。`SessionComposerModeSelector.tsx:802` 宽度上限 280dp，发送按钮和左边距另占 48dp。新建页 `SessionConfigPanel.tsx:1744` 也未传入会话页使用的 `compact`。 | 源码确认不合理的横向空间分配，与截图一致。280dp 是上限，不是每次实际测量值。优先保障固定动作可达，让模型区域承担剩余宽度；仅缩字、缩图标或加 compact 不能证明问题解决。 |
| A2 / P1 | 用户截图中力度面板与底部输入框之间有大段空白。`SessionComposerModeSelector.tsx:261` 仅打开时 `measureInWindow`，`:75` 以该锚点定位，`:798` 用原生透明 Modal；底层 `ComposeHome.tsx:845` 使用键盘避让。权限面板同样一次测量锚点。 | Android 36 的当前真实组件已复现：键盘打开时点模型，Modal 打开使键盘收起，输入框下移但浮层保留旧锚点，形成大段空白。用户截图的版本仍未核对，不能据此宣称已操作其手机。修复应统一原生浮层、安全区和键盘坐标生命周期，而非改一个固定 bottom 值。 |
| A3 / P1 | Antigravity 新建型号来自旧会话。`SessionConfigPanel.tsx:1043` → `newSessionModelMetadata.ts:19`，限定同机器、同 Agent 的历史 models。无目录时 `modelModeOptions.ts:169` 只剩 default，`:309` 无 effort。`:1752` 的主动刷新只覆盖 Magpie / Claude。 | 源码确认首次使用、历史未加载或目录过期时缺乏主动发现、加载失败与恢复入口。不能把没取到能力解释成 Agent 没有能力。通过用户动作或事件刷新，不加轮询。 |
| A4 / P1 | Antigravity 已选型号消失时可能静默回退。`newSessionModeSelection.ts:63` 回退默认或首项；`SessionConfigPanel.tsx:1201` 重设当前选择，`:1498` 阻止失效型号发送的保护只覆盖 Codex / Claude；`:1217` 对目录未到时保护 effort 也只覆盖 Codex，`:1226` 可清空 Antigravity effort。 | 源码确认保护不对称，尚未重演用户本次选择过程。应保留显式选择、区分目录未知/失败/已移除，在确实不可用时解释并阻止错误配置发送。补目录暂缺、恢复、重排、移除及首消息配置一致性回归。 |
| A5 / P1 | 模型 13sp、权限 12sp，均使用 `textSecondary`；见 `SessionComposerModeSelector.tsx:814` 与 `SessionComposerPermissionSelector.tsx:277`。暖色主题的前景和背景来自 `themePacksData.ts`、`themePacks.ts:77`。 | 源码颜色计算：caramel 在 input / selected 上为 2.99 / 2.71:1；acorn 为 3.10 / 2.82:1，低于普通文字 4.5:1 目标。应修复语义前景与状态配色，再原生检查；不用整体 opacity 降低关键文字清晰度。 |
| A6 / P2 | 点击整条模型标签先开力度；换型号需再点面板中央的小文字（`SessionComposerModeSelector.tsx:617`）。右上 Agent 图标执行循环切换（`:649`），完整 Agent 列表在下一层。 | 源码确认存在操作层级和含义隐晦的问题，不等同于所有项都无法选择。图标循环也是已有用户约定，不能把原设计一律定为程序 Bug 或擅自替换；修复需保留有效决定，验证每个可见入口的触控和选择反馈。 |
| A7 / P2 | Android 机器/目录使用底部 Sheet、键盘避让和滚动（`SessionConfigPanel.tsx:1592`），型号/力度/权限却采用另一套锚点 Modal；首页原生容器为 View（`ComposeHome.tsx:792`），没有整体滚动兜底。 | 交互策略不一致是源码事实；短屏＋键盘＋长文＋大字体造成的垂直溢出仍需逐场景原生验证。优先复用能保持草稿与返回顺序的原生选择表面，不新增常驻输入条。 |

正文“输入时看不清”需另查：`MultiTextInput.tsx:103` 使用 16sp / 22sp 和 `input.text`，acorn 正文配色对比度约 12.24:1。不能把次要控件的配色缺陷外推成正文输入法、光标或滚动问题的根因；必须在 IME 和系统字号下录制输入过程。

能力边界：当前 Antigravity 不提供 Codex 的自动批准模式；effort 应以执行端公布的范围为准。`newSessionExperience.ts:53` 还排除了 Antigravity 的图片/媒体选择回调，但 `MessageComposer.tsx:1083` 的通用上下文加号仍可存在；不能把加号出现认作图片能力已支持，也不能认定全部文件/引用都不可用。

## 全流程检查与证据缺口

| 阶段 | 本轮检查 | 必须补充的原生行为 |
| --- | --- | --- |
| 进入首页 / 新建 | `/new` 复用 `ComposeHome`，截图现象与共享组件对照 | 首次进入、草稿恢复、短屏布局、系统字号 |
| 机器与工作目录 | 配置入口和 Android Sheet 路径 | 机器离线、目录搜索、键盘和返回、切机器不串目录 |
| Agent / 型号 / 力度 | 目录来源、菜单层级、暂缺与移除保护 | 首用 Antigravity、刷新失败、真实目录变更、滑动与逐项点击 |
| 权限 | 选择器、模式支持与布局 | 批准/完全访问选择及确认、取消保持原值、按钮可达 |
| 输入与内容 | 原生 TextInput、主题、上下文加号和媒体回调 | 中文拼音组合、多行编辑、移动光标、滚动至末尾、附件/引用删除 |
| 创建 / 首消息 | `ComposeHome` → live selection → `newSessionSpawnSettings` → first submission → configure spawned session → message mode metadata → CLI ACP 配置确认 | 以实际启动/首消息回执核对机器、目录、Agent、型号、力度、权限与界面一致；验证失败保草稿、重试不重复创建 |
| 返回与恢复 | 代码检查，未冒充运行结果 | 模态返回先关闭当前层，草稿/选择保留；前后台、重开后仍可继续 |

## 自动化证据如何解读

`MessageComposer.screenshot.test.tsx` 使用 react-test-renderer，模拟 iOS 和 View/Text/输入框/选择器，没有生成 Android 截图。`SessionComposerModeSelector.test.tsx:12` 将 Modal 替换为 children、固定窗口尺寸；其中 Android 分支与拖动测试证明 JS 回调，不证明 Yoga 几何、原生窗口、键盘、触控或字体表现。

本轮定向检查结果与原生复现结果见下方执行记录。测试通过不撤销上述布局与设备证据缺口。历史 Android OPS 中 Antigravity、模型连接与推理强度改动也明确将“OTA 制品核验”和“手机加载/交互未验”分开；不能把其 Web 成功或包哈希扩大为 Android 体验验收。

## Android 验收门槛

1. 锁定来源：设备/Android/输入法、屏宽 dp、fontScale、包名、APK 版本、OTA Update ID、runtime 与源码 SHA。固定 OTA 版本，不能用持续变化的 preview latest 指针代表候选。
2. 模拟器执行真实 RN 组件与完整 App 两层检查。代表宽度包括 360 / 390 / 430dp，至少补 320dp 边界、系统字体放大、浅色与深色。组件 fixture 可定位窗口和布局，完整 App 才能验证配置目录、登录、创建和恢复。
3. 用连续原生录屏覆盖“进入→选择→中文长文输入→键盘开关→全部浮层选择/退出→发送→真实回复/完成”；保存截图、UI hierarchy、精确步骤、实际回执和必要日志。录像不能由 Web 手机视口或静态稿替代。
4. 后台配置与首消息实际执行一致；验证无目录、离线、失败/重试和草稿保护，不能只检查选中标签变化。
5. 最后在用户当前手机、日常入口和已核对的候选版本复验。模拟器通过仅代表对应模拟器范围；缺少真机访问时继续保持“用户手机未验”，不声称产品已修好。

本轮未发布 APK 或 OTA，没有改变权限、原生模块或 runtime。后续若只修 JS/UI，按机器可读 runtime 契约判定 OTA 兼容性；若改原生配置则使用匹配 APK。发布与当前设备验收分别完成。

## 本轮执行记录

- 根工作区检查：干净 main，HEAD 与本地 origin/main 均为上述 SHA；诊断文件和原生实验位于独立 sibling worktree。
- 初始 `adb devices -l`：无连接设备；本轮没有用户手机访问或验收证据。
- 启动已有 `Paws_API_36` 模拟器 `emulator-5584`，Android API 36，1080×2424px，420dpi；已有 `build.paws.dev` 开发壳 versionName 1.7.1 / versionCode 1。开发壳版本不能证明当前 JS 或用户 OTA 版本。
- 安装 sibling 依赖时跳过构建脚本，首轮 3 个测试 suite 因缺少 `happy-wire/dist` 未加载；完成该 workspace 的 build 后重新运行。这是诊断环境准备问题，不计作产品失败或测试成功。
- 定向自动化：6 文件 / 103 项通过。覆盖 SessionComposerModeSelector、SessionComposerPermissionSelector、SessionConfigPanel、newSessionModeSelection、newSessionModelMetadata、newSessionExperience。未改产品源码，未为纯诊断跑无关整库测试。
- 原生组件实验：现有开发壳加载当前源码的 MessageComposer、MultiTextInput、SessionComposerModeSelector 与 SessionComposerPermissionSelector；测试机名、目录和模型目录是 fixture，发送处理为本地计数。该实验没有跑完整 ComposeHome、真实登录、Antigravity 目录请求或模型首消息，不把它们计作成功。fixture 的权限控件传了 `supportsAutomatic=true`，生产仅 Codex 为 true；本实验只验证 confirm 标签几何，不验证 Antigravity 权限选项范围。
- Android 16 / API 36，系统 fontScale 1.0，输入法为 Google LatinIME（当时界面提供拼音模式）。真实截图已复现权限区挤压及键盘关闭后浮层脱离；保留原生录屏和步骤记录。弹层动效令 UIAutomator 无法取得空闲态时，旧 XML 不作为弹层层级证据。
- 媒体、fixture 源码、复现步骤与 `native-evidence.json` 归档到本机 `Development/Artifacts/paws/android-new-session-audit-20261127/`，开发工作树 `.audit-evidence/` 保留原始副本。关键证据为 `01-native-composer-411dp.png`、`02-keyboard.png`、`03-popup-from-keyboard.png`、`04-model-list.png`。初始 XML 的权限文字实际边界宽 17px，按 420dpi 为 6.48dp；浮层动效时的旧 XML 已丢弃。
- 交付 `native-new-session-repro-24s.mp4`，24.000 秒、1080×2424、H.264/yuv420p/30fps，来自原生 screenrecord 的连续前 24 秒，未拼接顺序。主任务独立完整解码通过。两张关键 PNG 与该 MP4 已经 Happy 工具发送成功，完整视频与精确哈希保留在归档。
- 临时 `index.ts` 完全恢复，fixture 移到证据目录，Metro 8097 与其 ADB reverse 已停止，模拟器尺寸恢复并回到启动器；没有安装 APK、清数据、使用生产登录或发送真实模型消息。用户真机仍未连接或验收。

独立复核已核对源码、fixture 与截图范围；发现的 fixture 权限能力差异已在上文明确。诊断已完成，产品修复与完整原生流程验收未完成。
