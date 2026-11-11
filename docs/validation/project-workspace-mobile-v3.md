# 手机项目工作区 V3 实施与验证

基线：`66b9cf2df80817a8e4115c31cb4e2bbab7667db2`。本次实现已审阅的手机交互。用户随后明确要求“合并并发布”，按 main CI 发布正式 Web 与 Android production OTA；本次不包含 APK 或 CLI 发布。

## 用户可见变化

- 沿用原 App 首页和抽屉，在侧栏加入项目入口。项目、子项目、Task 保持原档案关系。
- Task 卡片正文打开详情；独立对话按钮复用最新会话。无历史须明确点击，历史读取失败不当作空历史。
- 同一 Task 内用“对话／详情／文件”切换，切视图与历史会话替换当前路由参数。文件阅读才增加一级页面，返回保留来源与草稿。
- 手机头部使用返回、Task 名称和“更多”。刷新或直达 Task 后返回其目录；没有子项目的项目不凭空增加目录层。
- 原生 Task 文件绑定使用触控阅读器，支持文本、Markdown、HTML 和图片；原生 PDF／音频／视频明确显示不支持，禁止从阅读器或详情确认未能阅读的文件。
- 产物确认仍绑定已读具体版本，AI 完成不代替人工确认。

## 证据范围

使用完整 App、隔离 PGlite 账号、真实加密 RPC、真实合成档案与 relay session；启动器为 stub，未启动生产 daemon/model。所有浏览器操作使用 Ego。合成档案不代表用户真实项目验收。

| Case | 实测结果 | 边界 |
| --- | --- | --- |
| M1 入口与返回 | 手机侧栏进入项目；项目/子项目/Task 正确；正文返回清单。刷新后 Task→清单、feature-only 直达 Task→清单→所属项目通过 | 无子项目和 author 冷链回退另有单测；不声称真机系统手势通过 |
| M2 复用与新建 | 有历史 Task 正文零创建；继续打开预期最新 session，仍零创建。空历史 Task 正文零创建；显式打开创建 1 条，刷新/重复进入仍 1 条。提交/模型接收均 0 | 失败重试、双击、失焦晚响应由 hook 测试覆盖；真实 worker 启动未验证 |
| M3 同层切换 | 连续六次详情/文件/对话切换 history.length 不变；历史切换不增加条目；原草稿保留。旧会话刷新仍为同一 session 与独立草稿 | 浏览器 history.length 含前进条目，不作为绝对返回深度；同时实际验证返回目的地 |
| M4 文件与确认 | Markdown 原文件正文读回；阅读器返回 Files，切 Chat 原草稿仍在；确认弹窗取消后保持待确认 | 确认版本校验沿用现有 RPC 和单测；本轮没有接受真实产物。侧栏显式 Task/session 精准路由有单测，fixture 的旧 session 无显式绑定，未冒称完整侧栏 E2E |
| M5 小屏/主题/原生 | Gingham 深色的 320×568、390×500、430×932 无全页横向溢出，输入框位于可视区；新增头部按钮及三 Tab 的触控高度均为 44px。1440×900 桌面仍显示聊天与详情，无手机头部。Android JS/Hermes export 通过 | adb 无连接设备，未验证 Android/iOS 键盘、系统返回、安全区或原生 WebView；浏览器手机尺寸不是 Android 真机 |

独立代码评审通过，修正过未知请求重试重复、后台页面晚响应跳转、最新历史合并、冷链接老会话 hydration、安全区重复、未支持媒体确认、阅读位置作用域和后台文件事件。浏览器实测另外修正全部项目误选首项目，以及冷链接返回首页/跳过父项目。

Gingham 深色实测选中 Tab `rgb(40, 53, 68)`、悬停 Tab `rgb(26, 35, 48)`，均来自主题语义色。仅对新手机 Tab/头部启用 44px 触控尺寸，保留桌面默认密度；原有聊天发送控件未重设计。小屏高度模拟不等于真实软键盘验收。

“更多”底部菜单的 Web 滑入包装曾留在视口下方，遮罩拦截操作但菜单不可达；Web 改为无 RN Modal 动画后，实际 dialog 为 `(0,0,390,844)`，项目入口、刷新、Agent 和机器操作可见。原生保留 slide，效果仍待真机。机器连接失败后的手机刷新入口沿用桌面 `canRetryMachine` 条件，允许用户触发重试。

## 自动检查与复跑

10 个相关测试文件共 59 项（最后补充冷链接测试），包括 route、cache、history、async continuation 和 Android runtime contract；全部通过。完整 `tsc --noEmit --incremental false` 通过。Metro 生成空路由声明时先运行已有 `e2e/fixtures/goal-board/repair-router-types.mjs`，没有修改实际路由规避类型错误。

```sh
pnpm exec tsx --tsconfig packages/happy-cli/tsconfig.json packages/happy-app/e2e/fixtures/project-goals/serve.mjs
```

从 fixture 私有 auth 文件在 Ego 打开完整 App，按 Case 操作；使用 controller `/metrics` 对照创建和提交数量，不打印或发布认证 URL。手机尺寸切换后须等待 React 布局更新；Ego 回合可能恢复桌面尺寸，重新设定后通过 visualViewport resize 和绘制帧等待实际布局，再点击。只关闭本轮 fixture 和 Ego 空间，不操作正式进程。

## 审阅状态

PR 前后截图偏好已询问，尚未收到答复；本轮未采集截图、视频或 Happy Skills 关键帧，不作像素/视觉通过声明。独立交互评审：M1–M4 行为与 M5 DOM 几何 pass，整体手机交互 Gate 4 blocked（缺视觉/真机证据）。前轮先交付本地源码与定向 preview OTA；本轮用户已明确要求“合并并发布”，继续正常 PR、现有 CI 和正式发布流程。保留上述视觉/真机缺口，不将发布授权记为手机交互通过或用户产物认可。
