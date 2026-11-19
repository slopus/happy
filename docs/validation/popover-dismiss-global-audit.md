# 全局 Web 外部点击关闭专项排查

本轮由用户追问“全局是否还有很多同类问题”扩展。范围是 Happy/Paws App 自有 Web 的临时菜单、选择器、弹窗和关闭基础设施；不是全站浏览器 E2E，也不包含 Tauri、第三方插件内部 UI 或跨域 iframe 内部的事件行为。

## 查找与证据边界

扫描 `sources` 下真实组件和路由：Modal/RNModal/BaseModal、Portal、menu/listbox/dropdown/popover、open/picker 状态与 absolute/fixed 容器。三组候选分别为 45 个 Modal/Portal 文件、49 个浮层相关文件和 71 个定位容器文件，彼此重叠，不能相加当作控件数量。排除测试、历史 trash、生成图片目录；追踪父级容器后判断关闭由谁负责。

本轮代码和组件/DOM 回归共 229 项、18 文件通过；完整 App TypeScript 检查通过。独立 review 先发现目录面板漏 ref 和关闭标记返回旧文本误命中，修复并补回归后复核通过。

上一轮真实 Ego/RNWeb 会话面板隔离验证保留。下表中的“已有机制”仅指代码审查未发现同类缺口，不表示所有线上页面均已逐项用浏览器通过。未采集截图或视频；此前截图选择尚未回复，不以此阻碍修复。

## 页面与状态

| 代表区域 | 检查状态 | 验证方式 |
|---|---|---|
| 会话头部及侧栏 | 打开的设置面板、账号/帮助菜单 | 上轮真实 RNWeb 面板 + 组件/DOM 回归 |
| 消息输入区 | 有 `/` 建议、`@` 菜单、关闭后改写/退格 | 本轮状态回归；内容菜单为实际 RNWeb DOM + pointer 事件 |
| 侧栏 List 表单 | 草稿名称、电脑→目录选择、Agent 选择 | 本轮 DOM pointer + 组件回归，检查不丢表单草稿 |
| 设置 / Codex 默认账号 | 当前绑定、打开账号选择菜单 | 本轮 DOM pointer + 实际组件回归，不写绑定 |
| 项目 / 收藏文件 | 打开的只读文件弹窗 | 本轮实际 RNWeb Modal / Pressable / DOM 点击 |
| 文件/消息评注 | 打开的评注编辑/预览，外部控件停止冒泡 | 本轮实际 DOM 回归 |
| 其他 Modal / Portal / 菜单 | 下表列出的关闭委托和边界 | 源码检查 + 已有相关回归；非完整生产浏览器验收 |

## 逐项登记

| 入口/表面 | 结果 | 依据与处理 |
|---|---|---|
| 会话顶部设置面板 | 上轮已修 | `SessionInfoDropdown`：跨栏捕获关闭，透明 gutter 透传，所属触发器排除 |
| 新建会话侧栏配置选择器 | 上轮已修 | `SessionConfigPanel`：内联选择器外点关闭，记录当前 trigger |
| 侧栏账号菜单 | 上轮已修 | `SidebarView`：局部遮罩之外也能关闭，外点不回抢焦点 |
| 侧栏帮助菜单 | 上轮已修 | 与账号菜单共用 footer 关闭所有者 |
| `/` 等输入建议列表 | 本轮确认并修复 | `MessageComposer` 原来没有外点入口；增加关闭标记与外点监听，Escape 不改草稿；输入离开旧状态后清除标记，退格回原字串可重开 |
| List 默认电脑/目录/Agent 三选择区 | 本轮确认并修复 | `ListEditorDialog` 原来只在选择或重复点 trigger 时关闭；新增面板/三个 trigger 边界，点表单其他部位只关选择区、不丢名称草稿；目录内部选择单独回归 |
| 设置 / 电脑 Codex 默认账号选择 | 本轮确认并修复 | `CodexAccountBindingCell` 原来仅选择/取消/trigger可关；新增 cell 所属边界，外点只关菜单、不改绑定 |
| 项目子项目文件弹窗 | 本轮确认并修复 | `ProjectFeatureFiles` 背景原来仅 View 绘色无点击处理；binding明确只读，新增 Web 专用 sibling backdrop |
| 收藏文件弹窗 | 本轮确认并修复 | `ProjectSavedFile` 同上，binding明确 readOnly；原生 fallback 不增加关闭行为 |
| `@` / 加号内容选择菜单 | 本轮补强 | `ComposerContextPicker` 原来 mousedown 冒泡可被拦，且全局排除所有 composer；改捕获 pointerdown + 明确 ownerRef，其他输入框不再误当内部；同时修复旧 query 关闭标记回流 |
| 评注气泡/编辑/预览及选区按钮 | 本轮补强 | `MessageAnnotations.web` 外点监听改为捕获；补停止冒泡外部控件回归；保留内部选择逻辑 |
| 阅读宽度菜单 | 本轮补强 | `SessionView` 外点监听改为捕获，保留 commitWidth 和 Escape |
| 输入框模型/推理强度菜单 | 已有机制 | `SessionComposerModeSelector` / legacy：Modal 中全屏 sibling backdrop |
| 输入框权限菜单 | 已有机制 | `SessionComposerPermissionSelector`：Modal 全屏关闭遮罩 |
| 输入框工作目录菜单 | 已有机制 | `SessionComposerDirectorySelector`：Modal 全屏关闭遮罩 |
| 新建会话普通 Web 配置选择器 | 已有机制 | `SessionConfigPanel` Modal root + full scrim，不与 sidebar inline 混淆 |
| 会话列表更多/右键菜单 | 已有机制 | `SessionRowChrome` inline capture listener；非 inline `SessionActionsPopover` Modal backdrop |
| 项目/Agent 空间会话右键菜单 | 已有机制 | 委托同一非 inline `SessionActionsPopover` |
| 文件标签右键菜单 | 已有机制 | `FileTabContextMenu.web` body Portal + fixed inset backdrop，内部 target 区分 |
| 项目卡片操作菜单 | 已有机制 | `ProjectGallery` Modal 全屏 Pressable backdrop |
| 项目会话历史菜单 | 已有机制 | `ProjectConversationHeader` Modal sibling backdrop |
| 项目任务切换菜单 | 已有机制 | `ProjectTaskSwitcher` Modal sibling backdrop |
| 项目全局会话监控 | 已有机制 | `ProjectSessionMonitor.web` Modal sibling backdrop |
| 侧栏标签操作/详情操作菜单 | 已有机制 | `DesktopTagDialog` RNModal 全屏 responder backdrop，与面板平级 |
| 标签详情、List 编辑、会话整理等对话框 | 已有机制 | 共用 `DesktopDialogFrame`，其背景响应器与 card 平级 |
| 桌面设置/账号等路由弹窗 | 已有机制 | `DesktopAppStack` full overlay Pressable backdrop |
| 使用量详情 | 已有机制 | `UsageDialog` Web scrim onClick 与 card 平级 |
| 浏览步骤查看 | 已有机制 | `BrowserStepsPopover` Modal 全屏 scrim；图片查看另有自身关闭 |
| 图片风格图库/提示词预览 | 已有机制 | `ImageStyleGallerySheet` 外层、嵌套预览各自有 Modal scrim |
| OTA 版本详情 | 已有机制 | `OtaVersionSheet` TouchableWithoutFeedback + full backdrop |
| 命令面板 | 已有机制 | `CommandPaletteModal` 专用关闭动画、full backdrop |
| 分享/附件来源/锚点/复制等自定义 sheet | 已有机制 | 由 `Modal.show` → `CustomModal` → `BaseModal` 提供默认可关闭背景；不是各自重复造背景 |
| alert/confirm/prompt | 明确保留 | `WebAlertModal`、`WebPromptModal` 显式 closeOnBackdrop=false，避免把背景点击当作确认/取消 |
| 交付编辑器 | 明确保留 | `ProjectDeliveryEditor` 有未保存输入与 busy；此次不把它改成背景一碰即丢草稿 |
| 文件工作区常驻栏、Bots、折叠详情、Tooltip、全屏媒体 | 非同类临时菜单 | 常驻/明确展开的面板不应一律变为外点关闭；Tooltip 按 hover/focus 退出，媒体按自身关闭协议 |
| FloatingOverlay | 无生产调用 | 仅样式/滚动容器，实际建议列表关闭归 MessageComposer，不在未用容器上伪造全局能力 |

## 未覆盖和后续边界

- 不宣称已经在生产账号逐页点完所有动态入口。设置、项目实体、活动会话、媒体/iframe、插件内部需要真实集成数据分别验收；本轮完整源码审查与定向实际 DOM/组件验证不能替代这些证据。
- 非父文档的 iframe 点击不冒泡到父 document；本轮未增加 iframe 焦点桥接，不能承诺任意嵌入页面点击都会触发父菜单的捕获监听。
- PR #839 未合并前，线上用户仍运行旧版；正式 Web 只通过 main 合并后的既有 CI/CD 发布。本轮不额外发布临时站点、不改 runtime 或重建 APK。
