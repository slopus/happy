# Web IndexedDB 迁移实现与验证

2026-11-22；基线 `8a90e4c372959e8078f5d393577905cb5f5957fb`；分支 `fix/web-indexeddb-storage`。

状态：方案已修订、实现和核心验收已完成；用户已授权合并发布。PR、合并与上线结果另由发布回执记录，不能仅以此文档证明已上线。根工作区保持 clean main。

## 已实现

- 在 `index.ts`、主题和 Router 执行前初始化 IndexedDB 并导入已登记的旧业务 namespace。数据库不可用时保留原数据，提供重试，不假装保存成功。
- `deviceStorage.web.ts` 保留水合后的同步读取，异步草稿写入有独立 pending/failed/conflict/recovery 状态及私人恢复导出。原生 `deviceStorage.ts` 继续直接使用 MMKV。
- 首次提交恢复、消息队列、分享队列及继续会话的远端副作用等待持久提交；消息队列串行执行 reducer，避免两个调用基于同一个旧快照互相覆盖。
- 保留原消息队列 namespace/生命周期锁；导入的旧待发送记录标为待核对。Web 分享队列使用生命周期所有权锁；刷新后的 running 发布进入未知结果失败态，不自动再次发布。
- CAS 冲突保留副本；无关写入不会推进其他业务记录的 revision。缓存按写入更新时间淘汰，总预算 32 MiB、单记录 2 MiB；真实 quota 最多清缓存后重试一次。
- namespace/account/record epoch 撤销；退出时从 IDB 权威枚举 staging namespace，清理恢复正文并保留无正文退休标记，阻断旧源重新导入和迟到写入。撤销写入不会作为 conflict 正文重新存入。
- Developer 中增加 Web 存储计数/估算字节与只清可重建缓存入口；保留凭据、草稿和附件原件。广播及页面重新获得焦点仅触发一次检查，不增加业务轮询。
- 认证 token、账号索引与服务地址维持现有 localStorage 架构；这不是认证架构迁移，也不是任意 origin 配额都能无限写入的保证。

完整映射见 [存储清单](web-storage-inventory.md)。实施选择与原方案差异见方案末尾“实施收敛记录”。

## 验证结果

| 验收项 | 结果与边界 |
|---|---|
| 全量 Vitest | 576 个文件：573 通过、3 失败；5110 项测试：5105 通过、5 失败。5 项失败在未修改 main 的对应文件复跑同样出现，见下表 |
| 类型检查 | 使用项目锁定 TypeScript 5.9.3 的 `pnpm --filter happy-app exec node node_modules/typescript/bin/tsc --noEmit` 通过。当前环境通用 `tsc` 命令曾落到另一版本，产生 CSS side-effect import 诊断；未为迁移放宽 tsconfig |
| Web 构建 | `pnpm exec expo export --platform web --output-dir .storage-validation/export` 通过；非生产部署 |
| 真实 Chromium：存储层 | 独立合成数据 origin，触发 localStorage QuotaExceededError 后导入草稿，提交 9 MiB 文本，刷新后长度 3145728 中文字符完整恢复，pending/failed 均为 0，原草稿仍保留 |
| 真实 Chromium：完整应用 | 最新完整导出构建在另一独立 origin 填满 localStorage 后刷新，登录页正常显示；从 IDB 读取到合成旧草稿，旧 localStorage 原件仍保留 |
| 事务/并发/恢复自动测试 | 覆盖 transaction abort、不发布未提交队列、并发入队不覆盖、跨标签页 revision 冲突、旧源不复活删除、账号和精确记录撤销不保存私人冲突正文、缓存预算及隔离 |
| 独立代码 review | 多轮只读审查发现并修复 CAS、撤回竞态、分享未知结果重发、权威清理、scope 捕获顺序、撤销后恢复正文残留问题。最后限定复核确认最后两项修正到位 |
| 已登录真实发送、多标签页真实调度 | 隔离完整 App + 真实 PGlite / 加密传输通过；详情见下方追加验收。执行端为合成 stub，不调用模型 |
| Safari/WebKit、Android 运行、用户原浏览器 | 未执行；没有移动端/真机或原浏览器配额异常已修复的声明 |
| Developer 诊断 UI | 类型检查/构建通过；未独立浏览器点击验收 |
| APK / OTA / 正式 Web | 未发布。本次有共享队列 JS 改动，后续发布按现有兼容性分类、Android runtime 契约和 release-ops 执行，不能以 Web 专用标题跳过原生影响 |

已知基线失败：

| 文件 | 失败用例 |
|---|---|
| `sources/sync/webSoundAlerts.test.ts` | `rings for a failed turn transition, never for initial history hydration`；`rings again for a later failed turn when the session update time stays unchanged`；`rings again for a later completed turn when the session update time stays unchanged` |
| `sources/components/KeyboardShortcuts/KeyboardShortcutsModal.test.tsx` | `renders a presentational panel with a fixed header and scrolling body` |
| `sources/modal/components/CustomModal.test.tsx` | `provides one named modal boundary and closes from the panel or backdrop` |

未为使迁移测试变绿修改上述基线失败文件。

## Review 缺口的处理

1. 队列迁移不授予发送权：旧消息/未完成分享保守暂停，生命周期锁与迁移事务分开。
2. 异步提交以最新已提交快照执行 reducer；撤回先排入时，发送 reducer 检查不存在消息后停止。
3. 删除/退出保留无正文退休标记；旧源、坏记录、冲突副本的正文在显式清理时同步退役。
4. 单个坏源记录进入恢复副本，不阻断其他业务；整个 IDB 不可用仍需恢复页，不能把业务保存伪装为成功。
5. 暖缓存、大业务记录和容量保护已纳入第一批，不把它们留在 localStorage 等下一阶段。

## 证据与后续门槛

原始执行日志及合成浏览器 fixture 位于本 worktree 的 ignored `.superpowers/sdd/2026-11-22-web-indexeddb-migration/`。截图有 Happy session/run-bound receipt，已通过 report_browser_step 上报两项关键结果；未作为普通会话附件重复发送。

浏览器方法已写回 `ego-ops/references/sites/paws/operations/verify-indexeddb-migration.md`，站点/总索引更新，知识校验通过（59 个站点、313 个 operation）。Ego 提示有可用升级，本轮未升级工具。

已登录与多标签页追加验收见下；后续仍需 Safari/Android 适用回归；通过后再按 PR/发布契约交付。暂未向生产 origin 推送构建，也未移动用户私人数据。

## 已登录与真实多标签页追加验收

同日使用两个合成账号、三个真实 Chromium 标签页、独立完整 App / PGlite 服务端与真实加密消息通道验收，未使用正式账号或模型服务。

| Case | 实际结果 |
|---|---|
| IDB-AUTH-01 | 已登录草稿刷新恢复后发送，服务端及执行端均收到一次；另复跑新建会话首条消息，实际产生恢复记录 |
| IDB-TABS-02 | 两页各自入队，撤回一页后释放执行条件；撤回文本未发出，另一文本仅发送一次 |
| IDB-TABS-03 | 两页编辑同一草稿，canonical 与冲突副本均保留；通过真实 UI 下载恢复 JSON 并核对两份正文，刷新恢复 canonical |
| IDB-ACCOUNT-04 | 使用头像菜单真实切换 A/B；账号、消息和草稿隔离，刷新保持；A 退出后 B 的持久草稿及消息仍保留，可通过菜单重新选择 B |
| IDB-LOGOUT-05 | 在旧页初始化后再开第三页，持久化待发文本和实际 PNG 附件；旧页退出成功。数据库核对无 A 正文、无 A 恢复副本、无附件；B 保留；释放执行条件后无退出队列消息到达，旧第三页刷新不复活队列 |

本轮发现并修复：队列 namespace 注册改为事务内集合合并；相同初始化快照及可重建缓存不制造无效冲突；草稿延迟保存纳入 pending、beforeunload 和账号切换 flush；退出 compose 草稿使用 namespace 权威清理；恢复导出先捕获尚处于 debounce 的编辑，保存失败仍从 optimistic 导出。

回归中保留了失败后修复通过的日志。最终相关 14 文件、131 项测试通过，锁定 TypeScript 类型检查通过。先前全量测试的 5 项基线失败保持上表说明。本轮独立 review 未发现 P1 阻断，指出的恢复导出遗漏已补失败复现与通过回归。

原始截图/receipt、实际 Case 结果、恢复导出及关键状态帧在 ignored `packages/happy-app/test-results/indexeddb-migration/`；日志在 `.superpowers/sdd/2026-11-22-web-indexeddb-migration/followup/`。视频为关键状态回放，不能当作连续操作录屏。Safari/WebKit、Android 真机及正式发布仍未验收。

追加边界：非空草稿编辑后 390ms 内点击切换至第三合成账号，目标账号没有 B 草稿。切回 B 的最终读回因 Ego 执行通道持续无响应未完成，不能将此极短 debounce 场景列为浏览器通过；对应 scheduled editor flush 自动测试已通过。最后浏览器已上报的验证画面为退出 A 后仅保留 B 的账号列表。另有真实 B 页面状态帧确认原草稿及消息保留；未取得该画面的最终 Happy receipt，不冒充已上报。浏览器任务空间保留供恢复，未擅自重启用户浏览器。

回放 `indexeddb-key-state-replay-final.mp4`：约18秒、1920×1080、H.264/yuv420p、30fps、静音、faststart；媒体信息、全片解码与全时长抽帧核对通过，作为关键状态回放交付。不能替代连续交互录像。未包含恢复密钥输入。

清理：本 fixture 控制器 /shutdown 返回 200，后续检查其 server/web/controller 三个端口均无监听，fixture 主进程已退出；未停止其他工作区或正式服务。Ego 最终状态捕获及 task-space finish 因通道无响应未完成，已如实报告。
