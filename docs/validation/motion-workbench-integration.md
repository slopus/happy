# Motion Workbench 集成验证

日期：2026-11-26。实现基线：`471d0dac2e3611f3d0ee3a3fead53cb6d7964055`。分支：`motionharness-workbench`。

**集成整体部分完成；本次入口优化与 Mini 内容回改验收已完成。** 工程入口直接进入原生剪辑器，标签跟随工程名；真实 UI 改文字、保存标注、当前 AI 修改视觉/运镜参数、新构建安全载入及关闭重开已验证，验收录屏已发送。此前工程改名、关闭保护、刷新和深色主题的证据仍保留。Air 未进行本轮设备验收，也未上线；实际源码修改、原生版本恢复及正式影片导出仍未验证。

本轮随后补充固定「剪辑」入口、工程列表和自动登记，已通过组件/协议/文件系统与已安装引擎检查。新工具栏尚未在真实浏览器或 Air 验证，不能将前述旧入口录像当作这次列表界面的验收证据。

设计：[集成设计](../design/motion-workbench-integration.md)。机器可读脱敏结果：[E2E 读回](motion-workbench-e2e-20261126.json)。工程事实以这两份验证文件为准，不以测试数量替代用户路径。

## 实现与接口

- `happy-wire/src/motionWorkbench.ts`：工程/文档/构建/标注指纹、严格绑定与有界资源协议。
- CLI `modules/motionWorkbench/`：会话根目录真实路径校验，已安装 0.1.8 运行时选择、原生编辑器打包、受控资源和操作白名单、事件通知及取消打开/关闭释放。
- Web `components/motionWorkbench/`、`sync/motionWorkbench.web.ts`：完整原生文档和资源传输、校验、隔离 iframe、子窗口专用通道、账号/所有者保护、选中标注重校验与现有消息队列。
- `FileWorkspace.tsx`、`WorkspaceDirectoryPreview.tsx`：当前会话的 mh.json 入口，标签切换保留编辑器，关闭/源码切换/替换工程前检查原生保存状态。
- `MarkdownView.tsx`、`sessionFileLinks.ts`：在 Markdown href 边界一次解码 URI；文件树/代码原路径仍按字面值处理，继续执行原作用域检查。

`motionWorkbenchInspect/PrepareReview/Open/State/Resource/Operation/Close` 都注册在当前 session。Paws 不把 Mini 的原生回环访问凭据交给 Air，不另建 AI 队列。完整 authored document 保留实例、设置与原生字段；素材 Blob URL 在隔离子窗口创建。

## 自动验证

| 检查 | 结果 | 范围 |
| --- | --- | --- |
| wire Motion Workbench suite | 10 pass | 版本、选择、完整空快照、大小和提示词边界 |
| CLI bridge/editor 单测 | 15 pass | 真实文件系统作用域、完整文档、归属、取消打开与释放 |
| CLI 已安装引擎集成 | 2 pass | 原生工程、包/资源、改名、文件事件、标注快照与过期拒绝 |
| apiSession 回归 | 82 pass | 现有会话与新控制器周边，不替代真实新接口整链 |
| 本轮最终 App 定向回归 | 93 pass / 8 files | 工作台/资源、Markdown URI、文件/目录、Provider、打开文件和 Typography |
| happy-cli 完整 build | pass | 当前 CLI TypeScript 与打包；未在真实 fixture 活跃时重建 CLI |
| happy-app typecheck | pass | 入口修复后与清理后的最终核对均通过 |
| happy-wire build | pass | 新协议输出已构建并被原生/Web 实际消费 |
| 差异检查 | pass | 不提交临时工程、运行时包、认证资料或媒体采样帧 |

复跑：在 wire 包运行 `pnpm exec vitest run src/motionWorkbench.test.ts`。CLI 使用 `pnpm exec vitest run --config src/modules/motionWorkbench/vitest.config.ts`；只有设置宿主的 `PAWS_MOTIONHARNESS_BIN` 与自己的 `PAWS_MOTIONHARNESS_TEST_ARCHIVE` 才运行两项原生测试，否则明确 skip。单测/API 回归入口维持工程现有配置。

App 定向入口：`sessionFileLinks.test.ts`、`useOpenSessionFile.test.tsx`、`FileWorkspace.test.tsx`、`WorkspaceDirectoryPreview.test.tsx`、`SessionFileWorkspaceProvider.test.tsx`、`MarkdownView.typography.test.tsx` 与 `components/motionWorkbench/`。组件替身测试只证明其状态边界，不冒充真实账号或模型。

## 完整 App 真实验收

本轮用户明确批准临时隔离例外。复用 `e2e/fixtures/artifact-history/serve.mjs`，完整 Expo App、独立 PGlite 账号、真实当前分支 CLI daemon、spawned Paws Codex worker 与原生 app-server；模型为 gpt-6.1-sol / high、CLI 0.166.0。没有模型或文件编辑替身。已确认会话目录为影片副本的父目录且未继承父 Codex profile。

浏览器只使用 Ego OPS / Ego Browser，并以同一数值任务空间、精确目标和预期 URL 贯穿。认证引导与交付画面分开，六个完成/验证的关键状态已上报，最后独立 finish。初次编辑器根节点截图早于 GPU 首帧，不以该图证明实际影片显示；后续定位、刷新和主题状态均看到了真实影片。

| Case | 本轮真实结果 |
| --- | --- |
| M1-1 工程入口与画面 | 从真实 Agent 回复的聊天链接打开 mh.json，经实际加密 RPC 加载原生画布、46 实例轨道与音轨；定位 1.6 秒并显示对应画面 |
| M1-2 保存与 AI 回改 | 原生保存含截图和时间的标注，Paws 展示原评论；用户动作交给当前会话，真实 Agent 改名并核验，原生标题自动刷新 |
| M1-2 普通轮 | requestVersion 32，保存标题「Paws 内嵌回改验收」，最终 revision 34 |
| M1-2 录像轮 | 新请求 requestVersion 37，保存标题「Paws 内嵌回改复验」，最终 revision 39；原生 completed 事件与文件保存均读回 |
| 标注处理策略 | 两条请求原生 onResolve=delete；完成后只移除选中请求，原生历史当前项为 Agent 确认 AI 标记。没有伪造保留的 completion 行，也没有只用消失推断成功 |
| 内容保护 | 两轮 46 实例、输出设置和 58 个源码/素材文件哈希不变；原生同时间预览图字节一致；8.5 秒音频 PCM 一致（48kHz、双声道） |
| M1-3 关闭保护 | 未按回车保存的原生输入阻止关闭且文本仍在；清空临时输入后可关闭、重开同一保存结果 |
| M1-3 刷新 | 同一会话完整刷新后重新打开工程，标题保留，旧请求不复活；释放/重开没有占满绑定槽 |
| M1-3 主题 | 实际选择 Gingham + Dark；普通、hover、selected 颜色与当前 surface/surfacePressed/surfaceSelected 相符，原生影片仍显示 |
| 加密边界 | 在同一真实加密 session RPC 中，旧快照返回 STALE_REVIEW，父目录返回 PROJECT_NOT_ALLOWED，陌生绑定返回 BINDING_NOT_FOUND |

本轮 AI 回改目标是**工程名称元数据**，没有据此声称所有视觉字段、关键帧、动态源码热构建或影片导出均已验收。

## 遇到的问题与修复

1. 外置盘路径的空格在 Markdown href 中成为 `%20`，原文件入口按字面路径打开而报找不到文件。在 href 边界一次解码后，同一聊天链接成功进入工程；字面百分号路径、位置后缀、外链与越界回归通过。
2. 首次录像脚本在 Ego Node 内直接载入网络库，遇到浏览器全局对象隔离。业务回改未再次发送；只清理该失败录像新增的副本标注，改用 runtime 明确记录的真实 Node 子进程做加密读回，随后同一任务空间完整复跑通过。未交付失败录像。
3. 验证器最初假定完成后总保留 marker。读回原生 onResolve=delete 和确认历史后改为按真实策略验证；不把策略性删除误判为标注丢失。

## 可播放证据

`deliverables/paws-motion-workbench-acceptance-20261126.mp4` 已通过 Happy send_file 发送。

H.264 / yuv420p / TV range，1680×920，30fps 编码，60.066667 秒，1,758,942 bytes，faststart、静音。完整解码退出 0；抽查 0、4、8、22、40、59 秒，覆盖保存/队列/原生执行/自动刷新/完成态，无认证入口或凭据。

这是实际浏览器**采样录像**：160 个新鲜帧，采样跨度约 58.95 秒，最大帧间隔约 2.16 秒；编码 30fps 不等于采集 30fps，不称连续高帧率录屏。没有从其他 Ego 运行的临时截图取素材，也没有把关键帧回执图片拼成此片。

## 清理与原片保护

本轮原生项目只在便携包解出的独立副本中修改。最终 UI 状态上报并 finish 后，仅关闭本次原生影片副本，再由 fixture 的实际进程执行清理并退出 0。

已核对测试 Web/server/controller 无监听、独立 CLI home/Codex home/影片目录已移除、私有认证入口文件已移除，交付视频保留。没有改全局 CLI、重启生产 daemon、停止用户原 Studio 或操作 Air 原转发。

原工程 document.json SHA-256 前后均为：

`32557d26ab123d155c95dde13ce1c32c406e42436133fc04b8542859488a0021`

## 当前边界与未完成项

- **Air 当前设备未验**：此前 Tailscale offline、SSH 超时；本次追加验收在 Mini 完成，未重新断言 Air 当前网络状态，不能用 Mini 成功代替 Air。没有发布正式 Web。
- 真实断线/重连、完整 SPA 会话切换和未确认表单在浏览器刷新时的恢复仍待验证，不能由已保存结果的刷新测试推出。
- 视觉参数回改和新 build 载入已由下述追加验收验证；实际源码修改、原生历史/检查点恢复与「交给 AI 导出 MP4」仍未验证。导出按钮表示任务排队，不表示渲染完成。
- 独立代码/交互评审未执行：当前配置的自动角色仅适于写作，没有替换为未配置执行器或把作者自查记成独立评审。
- PR、合并和 Web/OTA 发布未执行，开发分支不作为上线完成证明；第三方运行时许可与分发边界沿设计说明。

## 经验维护

Ego OPS 新增 `references/sites/paws/operations/verify-motion-workbench-roundtrip.md`，保留原 MotionHarness 独立宿主 operation；本次 operation 校验无问题。全库仍有三个其他并行 Paws role operation 的既有索引/占位错误，未改他人条目，不宣称全库通过。

Web E2E / Codex Harness 保存可复用的 URI、原生处理策略、独立 Node 观察和分层验收方法。Confirmation OPS 记录本次隔离例外与实际结果，不改变长期正式环境默认。Air 无新 SSH 成功证据，不刷新成功日期。没有 Cloudflare 或正式发布，不刷新对应部署日期。

Codex OPS 本轮复用已登录原生工具与已有隔离夹具，没有认证修复或全局配置变化，不新建重复运维记录；真实模型成功与临时认证目录清理以本报告为准。

## 追加：固定剪辑入口与工程发现

针对「找不到影片工程」与「是否单独启动服务」两条批注，用户同意补齐入口。PC Web 普通会话、项目会话工具栏新增「剪辑」；完整列表只有一个工程时直接打开，多个时按保存名称搜索选择。打开动作自动准备或复用 MotionHarness；浏览工程列表不启动服务。空列表可让当前 AI 创建影片，或登记当前工作目录内的已有工程。

范围仍是**当前会话工作目录及子目录**，不是整台机器。索引按 server 与 canonical root 隔离，仅保存路径/最近打开时间；标题从原生文档实时读取。跳过依赖、构建、缓存和 symlink，目录扫描及索引逐项有界读取，超限明确返回部分列表。已登记的深层工程保留；缺失、越界或被替换的工程不能借旧索引取得访问权。新建/导入工程在打开列表或已有完成事件后识别，没有后台周期扫描。

| Case | 验证层次 | 结果 |
| --- | --- | --- |
| M3-1 单个/多个工程入口 | React 组件替身 | 单个完整结果重新校验后直接打开；多个/部分结果由用户选取 |
| M3-2 发现与命名 | 真实临时文件系统 | 新建/导入识别，登记跨 catalog 实例保留，文档改名后重新读名，原文档不改写 |
| M3-3 服务按需与边界 | CLI handler / 已安装引擎 | 不存在的引擎路径仍可列出/登记；真实工作台打开后写入索引，原生改名后列表显示新标题；父/兄弟目录、symlink 和恶意索引拒绝 |
| M3-4 重开与取消 | 组件/Provider | 已在代码模式的工程可从库入口重开且只消费一次请求；旧会话请求、账号变化、断线、关闭后的迟到结果不触发打开；输入取消/失败可恢复 |
| M3-5 AI 创建后发现 | 组件事件替身 | 仅用户点击才入现有队列；列表打开时新完成事件刷新一次，不自动再次发送或轮询。没有新增真实模型创建影片验收 |
| M3-6 真实新界面/当前设备 | 未执行 | 未新建隔离 App、未采集新截图/录像；前次隔离许可与清理只归前次验收，不当作新界面已验或已上线 |

本次最终定向 App **138 tests / 10 files**、wire **11 tests**、CLI **22 tests / 4 files** 通过；CLI 数量含两项已安装 MotionHarness 0.1.8 集成，非 skip。App typecheck、CLI 完整 build（含 TypeScript）通过。CLI 原有打包 warning 保留，构建退出 0；未重新链接全局 CLI 或重启生产 daemon。

原生测试仅将现有便携包解到临时工程；catalog storage 也注入临时目录。两项测试在 finally 关闭各自副本并移除临时根目录。原影片 `document.json` SHA-256 继续为 `32557d26ab123d155c95dde13ce1c32c406e42436133fc04b8542859488a0021`。本次没有新浏览器操作、Ego 截图、Cloudflare、发布或当前设备成功证据，不更新这些成功日期。

源码与脱敏验证记录已补齐；功能仍在开发分支。未推送、合并或部署，用户日常入口尚未加载本次新工具栏；Air、真实焦点/视口/主题和跨机全流程的未验边界保持。

## 追加：工程入口与真实内容回改

用户要求优化 `mh.json` 入口，并实测「界面编辑 → 输入文字要求 → AI 优化剪辑」。仍使用本任务已获准的完整隔离 App、真实 daemon/原生 worker 与可丢弃影片副本；原工程与正式服务保持。

| Case | 通过标准 | 实际证据 |
| --- | --- | --- |
| M2-1 影片入口 | 点击工程入口直接进入剪辑器，显示工程名，配置代码为显式入口 | 原生「Paws 宣传片」画布/轨道实际打开；文件保存/下载/路径工具栏在剪辑模式收起 |
| M2-2 用户编辑保留 | 在属性面板改主标题，保存并交给 AI 后仍保留 | UI 输入 `Paws keeps you moving.`，原生文档读回后再保存带截图、6.5 秒定位的标注 |
| M2-3 AI 内容与运镜回改 | 当前真实 Agent 只修改选中要求中的四个值 | 副标题变为 `Review. Refine. Release.`；字号 68/76；结尾推进倍率 `endDrift=1.035`；主标题保持 |
| M2-4 构建交接 | 原生构建编号变化后可以继续编辑，播放时间保留 | 普通轮及录像轮原生 buildId 均实际变化；检查草稿后自动重开完整构建并恢复 6.5 秒，无旧宿主断开状态 |
| M2-5 关闭重开 | 保存内容重开后不丢失 | 从当前会话 Files 重开同一入口，再检查画布与属性，两行文案和字号保持 |

普通通过轮：requestVersion **42**、最终文档 revision **44**。成功录像轮：requestVersion **60**、最终 revision **62**；真实加密完成事件、磁盘读回与画布一致。onResolve 为 delete；标注移除同时核对原生历史最后一项为 `Agent 确认 AI 标记`，source 为 agent。

46 个实例保持，仅结尾卡片的指定保存值变化；输出设置、工程名称、其余实例（含音轨参数）和 55 个源码/素材文件哈希不变。原工程文档 SHA 继续与上文相同。本次不把声音参数/素材保持外推为用户主观试听认可，也不把构建交接等同实际源码改写验收。

首次内容回改虽然保存值正确，但 Agent 的渲染核验使原生构建编号变化，旧宿主出现断开提示。修复为完成事件与构建变化任意顺序到达后安全重载；有未确认输入时保留编辑器，提供显式载入入口。定向回归覆盖两种事件顺序、播放时间恢复及草稿阻止重载。

录制脚本还修正了两类验证问题：默认视口快照会省略滚动面板字段，改用 full_page；原生重建会使 ref 失效，改用已观察的设置面板容器定位。长对话的旧链接未处在可操作视口时，重开使用当前会话 Files。最终影片为独立完整通过的录像复跑，未交付中断录像。

追加最终检查：**43 tests / 4 files** 及 App typecheck 通过；差异检查通过。录屏之后仅追加「带行号配置链接保持代码入口」的路由保护及单测；普通影片入口和回改实现没有再变化。独立评审、Air 与正式发布边界继续按上文，不以作者自查代替独立评审。

### 追加录屏与清理

`deliverables/paws-motion-content-ai-roundtrip-20261126.mp4` 已由 Happy send_file 发送。H.264 / yuv420p / TV range，1680×920，30fps 编码，89.066667 秒，2,181,282 bytes，静音、faststart；完整解码退出 0。全时长抽帧检查 0、3、7、35、76、81、88 秒；76 秒为原生安全重载过程，最终状态已回到正确画面。

262 个新鲜浏览器帧，采样跨度 87.071052 秒，实际约 **3.0fps**，最大帧间隔 3.653065 秒。它是浏览器采样录屏，不称连续 30fps 采集；聊天区保持原阅读位置，Files 重开时可见之前验收轮的历史回复，当前轮版本以加密读回 revision 62 为准。

本轮五个已验证关键状态按同一 session/run 的回执上报；最终帧已上报后独立 finish。已关闭本次原生副本，fixture 退出 0；测试 Web/server/controller 在 IPv4/IPv6 均无监听，影片目录、独立 CLI/Codex home 和私有认证入口已清理，视频与脱敏读回保留。正式 Paws、全局 CLI/daemon 与原片未改。

Ego OPS 的 `paws/operations/verify-motion-workbench-roundtrip.md` 与站点索引已更新。真实运行知识校验后，当前操作没有错误；全库仍有 **2 项无关角色评审文档的索引/占位错误**，未覆盖他人条目，不声称全库通过。Web E2E / Codex Harness / Confirmation OPS 更新本任务的方法与结果导航，不扩大本次隔离许可。
