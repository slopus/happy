# Paws Web IndexedDB 安全迁移方案与实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 Paws Web 中会持续增长的本地业务数据从 localStorage 迁到 IndexedDB，在配额耗尽、迁移中断和多标签页条件下保护草稿及待发送内容，避免存储异常中断整个应用。

**Architecture:** Web 专用异步持久层 + 显式启动水合门禁 + 事务迁移 + 分类容量管理。内存负责即时界面，IndexedDB 负责持久提交；关键操作必须等待提交确认，不使用伪同步后台写入冒充保存成功。原生继续使用现有 MMKV，通过平台适配保持业务契约。

**Tech Stack:** TypeScript、IndexedDB、现有 React/Zustand、Vitest；优先复用已有 IndexedDB 方法，不替换第三方 MMKV 实现。

**Spec:** 本文“设计约定”是本计划的设计基线；用户已于本轮明确授权修订方案并开始实施；未授权合并或正式发布。

基线：本地 main / origin/main = `8a90e4c372959e8078f5d393577905cb5f5957fb`，2026-11-22。执行前重新核对变动。

## Global Constraints

- 所有改动在 sibling worktree；根工作区保持 clean main，与 origin/main 一致。
- Web 专用实现优先 `.web.ts/.web.tsx`；原生 MMKV 行为不变，不纳入 Tauri。
- 不清空全站数据，不删除凭据、未发送内容或未知归属的旧数据；不跨 origin 搬运数据。
- 不以全局吞错、内存假保存或长期双写 localStorage 作为迁移方案。
- 不增加轮询；采用 IndexedDB 事务、Web Locks、BroadcastChannel 和用户动作触发的检查。
- 正式 Web 仍由 main 合并后的既有 CI/CD 发布到 `https://47.115.228.20:8443`；本计划不包含发布授权。
- 仅业务缓存的持久化失败可降级；关键草稿和队列必须区分内存状态与已提交状态。
- 实际浏览器验证只能使用 ego-ops → ego-browser；未经要求不采集 UI 前后截图。

## Review Focus

1. 旧标签页仍写 localStorage：新版本不能删掉它刚写入的草稿，也不能声称已阻断不合作的旧代码。
2. IDB transaction.oncomplete 前页面关闭：不得把 request.onsuccess 当作保存完成。
3. IndexedDB 不可用或升级 blocked：保留旧数据，显示明确恢复入口，不进入永久空白启动。
4. 账号切换/退出与异步提交交错：旧账号结果不能更新新账号，也不能复活已删除数据。
5. ACK 丢失、刷新与恢复队列交错：不能因本地失败重发已被服务端接受的消息。

## 一、设计约定

### 1. 已知事实与未确认边界

已核对：node_modules/react-native-mmkv/src/createMMKV.web.ts 的 set 直接调用 localStorage.setItem。实例前缀和账号 scope 不增加 origin 配额。persistence.ts 的草稿/设置、messageStagingQueuePersistence.ts 的队列存在同步直接写入；messageStagingQueue.ts 的 commit 先 save 再发布内存状态。AuthenticatedRootLayout.tsx 静态导入 sync/storage，部分读取发生在模块初始化。

localHistoryStore.ts 已使用 `paws-local-history-v1` IndexedDB；stagedAttachmentStorage.web.ts、relationshipAdvisorImageCache.web.ts 也已有独立库。本次不重写历史库和附件库。sessionWarmCache.ts 仍使用 MMKV，写入虽然捕获失败，成功写入时仍会占用 localStorage。

截图只有通用“错误/重试”；尚未在用户原浏览器捕获异常，不能把它写成已确认 QuotaExceededError，更不能认定防火墙拦截。5 MB 是常见 localStorage 限制的量级，不是所有浏览器/模式统一常量。

### 2. 迁移范围与数据分级

| 数据 | 目标 | 策略 |
|---|---|---|
| 会话草稿、新会话草稿、compose 草稿、文件编辑草稿 | 新 IDB 业务库 | 关键数据；按会话/文件独立记录，保存失败保留内存并提示 |
| 待发送队列、首次提交恢复记录、分享任务队列 | 新 IDB 业务库 | 关键数据；提交确认后才允许后续网络副作用 |
| 本地/待同步设置、置顶组织、项目偏好、评注及继续会话记录 | 新 IDB 业务库 | 区分可从服务器恢复与仅本地/待同步部分；未同步内容不可淘汰 |
| 工作区导航、项目缓存、暖缓存 | 新 IDB 业务库 | 可重建缓存，预算管理，失败允许绕过 |
| 历史消息及附件原件 | 现有 IDB 库 | 保持实现，纳入统一用量报告和清理分类，不重复搬运 |
| 活动账号指针、服务地址、启动主题 | localStorage 小型白名单 | 限量、限制字段长度；启动主题仅为业务设置的投影 |
| 认证 token、账号目录 | 维持当前认证架构 | 不借此次迁移改登录机制；检查目录增长与失败路径 |
| 临时大文本 temp_text_* | IDB 业务库 | 显式消费后清理；未知旧内容保留，不能按命名直接删除 |

执行时对所有 `react-native-mmkv` 导入及直接 localStorage 写入逐项建立 key 清单：生产者、消费者、账号归属、生命周期、是否可重建、字节规模。现有清单不是“全部已覆盖”的证明；发现新键必须归类后处理。

### 3. 三种路径与推荐

- 只给现有 set 加 catch：只能局部止血，不解决容量和数据可靠性，排除。
- 用内存镜像模拟同步 MMKV、后台异步写 IDB：可降低改动量，但刷新时可能丢已显示成功的队列，排除关键业务使用。
- 推荐显式异步持久层：改造量较大，但能让“已保存/已入队”与事务提交一致。设置可在启动时一次水合到内存，不要求每次渲染读数据库。

### 4. 存储模型与接口

新库拟名 `paws-web-state-v1`，版本 1。stores：`records`、`migrations`、`cacheEntries`。现有其他库保持独立，不宣称能跨库原子提交。

records 主键 `[scope, domain, id]`，value 带 schemaVersion、revision、updatedAt、payload；scope 复用当前账号命名逻辑并核实服务 origin，禁止仅按显示名归属。unknown/legacy 数据只在已有旧账号接管规则能证明归属时迁移，不自动归给当前登录用户。

建议新增 `sources/persistence/webStateDatabase.web.ts`，导出：
- `openWebStateDatabase(): Promise<WebStateDatabase>`
- `read<T>(key: StateKey): Promise<Versioned<T> | null>`
- `commit<T>(key: StateKey, value: T, expectedRevision: number | null): Promise<Versioned<T>>`
- `remove(key: StateKey, expectedRevision: number): Promise<void>`
- `purgeScope(scope: string): Promise<void>`

StateKey = `{ scope: string; domain: string; id: string }`。Versioned<T> = `{ revision: number; value: T }`。expectedRevision=null 表示要求不存在；不匹配返回类型化 conflict，不无条件覆盖。Revision 在同一 readwrite transaction 内校验并增加。删除与并发写入使用 scope epoch/tombstone 防复活。

统一错误类别：quota、unavailable、blocked、corrupt、conflict、account-changed。日志仅含类别、domain、字节数和版本，不记录正文、凭据或完整 key。

### 5. 启动与账号生命周期

新增 `components/appRoot/AuthenticatedBootstrap.web.tsx`，由 `_layout.tsx` 的 authenticated lazy 边界加载。流程：读取最小账号指针 → 打开数据库/导入当前 scope → 水合业务状态 → 动态 import AuthenticatedRootLayout → 恢复连接及队列。

必须先审计根布局、主题和间接导入图，保证水合之前不执行依赖业务默认值的模块级初始化。不能仅把 await 塞进 AuthenticatedRootLayout 的 useEffect；那时静态 import 已经发生。公共分享路由保持独立，无需打开私人业务库。

状态机：opening → migrating → hydrating → ready；失败进入 recoverable-error。打开/升级有单次超时和可操作错误页；超时不启动查询循环。不以默认空设置覆盖尚未加载的真实数据。

账号切换前等待/拒绝仍在提交的关键写入；使用当前 generation/epoch 丢弃迟到的 UI 更新，事务端也校验归属。退出时关闭当前订阅和队列，再按现有退出数据策略清理精确 scope，不影响其他账号。

### 6. 旧数据迁移协议

迁移是按 domain/key 可恢复的状态机：discovered → copied → verified → active → legacy-cleanup-pending → done。记录保存在新库 migrations，不能依赖已满的 localStorage 写进度。

1. 只读枚举已登记键并统计大小；原文保留在本机，不进入日志。
2. 新客户端以 Web Lock 串行执行迁移；不支持 Web Locks 时仍用 IDB 事务/CAS 保护新库，只读旧数据，不自动删除旧键。
3. 读取旧值 A，解析 schema；坏记录隔离、保留原键，关键域进入待恢复状态，不静默当成空数组。
4. 在单事务内创建不存在的目标记录及 copied 标记；重复执行不能覆盖较新的目标。队列保留原消息 ID、preparedText、deliveryUncertain、barrier 及附件引用。
5. 等 transaction.oncomplete，再独立读取目标校验记录数、字段及规范化内容摘要；校验只证明这次拷贝，不证明未来旧端停止写入。
6. 标记 active，新版本只写 IDB；不得长期双写。旧值变化时保留为待导入冲突：不同会话可合并，同一草稿多版本保留；队列按 ID 合并并保留不确定状态。
7. 对合作的新标签页用 BroadcastChannel 发版本/域变更事件；消息仅作失效通知，实际内容重读 IDB。没有 BroadcastChannel 时按用户动作/页面重新获得焦点单次重读，写入靠 CAS，不轮询。
8. 删除旧关键键需要排除旧写入并发。当前旧客户端不认识新锁和迁移标记，无法被新版本可靠禁止；因此首版默认保留关键旧键，不以“先比较再 removeItem”冒充原子操作。清理放在所有旧标签页关闭、重新打开新版后的受控维护阶段；无法证明时继续保留并提示，不能自动删除。
9. 旧缓存可在确认业务语义可重建后按白名单清理，即便旧页面重新写回也不损失用户原创内容。持续旧写入应提示关闭旧页，不能声称永久释放成功。

容量释放来自新数据停止进入 localStorage、删除可重建旧缓存、后续安全清理关键旧键。关键旧键暂存不是迁移失败，也不保证凭据等保留写入立刻有空间；满额时须保护它们的错误路径。不能把“代码已迁移”和“全部旧容量已释放”混为一项验收。

### 6a. Review 补充：接管、终态与故障隔离

- 队列保留原 namespace 和生命周期 Web Lock；迁移锁不能授予发送权。只恢复当前拥有锁的标签页队列；其他旧队列只备份、不合并进活动队列。无锁时保持原有新 namespace 策略，不自动接管旧队列。
- 迁移标记绑定旧原文摘要/版本。目标删除保留 revision tombstone；已迁移旧源不再覆盖新状态。旧源后续变化保存为恢复冲突，绝不自动合并进可发送队列，也不复活已发送/撤回内容。
- 单记录损坏隔离到恢复记录，不以空数组覆盖；可重建缓存损坏不阻断启动。数据库整体不可用进入恢复页，不在内存中假装完成关键保存。
- A 阶段必须含暖缓存迁移、可重建旧缓存清理、最小白名单写入失败保护；B 只后置低风险诊断与非关键体验完善。
- 异步队列串行执行 reducer，执行时基于最新快照计算，不串行提交调用时预构造的旧快照。加入连续入队、入队/ACK、撤回/发送交错用例。

### 7. 草稿与队列契约

草稿先更新内存，显示 saving；异步提交成功后显示 saved，失败显示 unsaved 并允许重试/导出。明确页面关闭前尚未提交的内容可能丢失，不依赖 unload/pagehide 启动异步写入保证可靠性。相同草稿并发修改用 revision 冲突保留分支，不用时间戳强制覆盖。

messageStagingQueue 的 commit 改为可 await 的串行事务路径；不是只修改 persistence.save 返回值。增加/编辑/撤回/发送/ACK/失败的所有调用者都必须 await 或明确处理错误。提交成功后才发布持久状态；UI 可以独立展示未提交输入，但不能称为已入队。

发送前持久化 sending 和稳定消息标识，再调用网络；服务端接受后本地 ACK 写失败须停留 deliveryUncertain，恢复时核对现有服务器消息/去重契约，不生成新 ID 自动重发。没有权威查证能力时保留人工核对入口。

附件继续先保存原件再提交队列引用；队列提交失败可留下可回收孤儿，不能先删原件。引用解除必须先提交队列，再删除附件。跨库无原子性，清理按引用核对、受限批次和事件触发执行。

### 8. 配额、故障与维护

初始产品预算：新库可重建缓存合计 32 MiB，单缓存记录最多 2 MiB；以序列化后的 UTF-8 估算，明确不等于实际磁盘占用。关键数据不受该淘汰预算控制，也不能无限增长：写不下就明确阻止新持久操作，允许导出/用户清理。

首版按缓存写入更新时间淘汰，预算元数据与记录在同事务维护；清理仅淘汰标记为 cache 的记录，批量写入前按预算清理。真实 quota 错误时先终止失败事务，清理可重建缓存，再仅重试原写一次；仍失败即返回类型化错误，无循环重试。其他现有库清理由其专属 API 执行，不整库误删附件或草稿。

navigator.storage.estimate() 仅作为 origin 总量参考，不能证明 localStorage 剩余容量。persistent storage 请求仅作降低自动驱逐概率的可选增强，拒绝不阻断；它不能消除配额或替代备份。

增加存储诊断入口：localStorage 键分类/估算大小、IDB 各域计数与估算大小、迁移状态、最后错误；操作为仅清理缓存、重试保存、导出未发送内容。导出需用户动作，提示包含私人内容，不上传到公开预览。

### 9. 上线、兼容与回退

建议两次可交付变更：A 完整基础层+迁移+启动+草稿/队列+暖缓存/大设置迁移及容量保护；B 诊断体验与受控旧数据清理。A 必须覆盖完整读写链路后才能发布，不能让新旧模块各写一半状态。

发布开关决定启动时使用哪条路径，迁移中途不能切存储。版本更低的旧 Web 不认识 IDB 新数据：迁移后优先修复前滚；不能直接回退到只读 localStorage 的旧包并宣称数据完整。必须回退时使用仍支持新库的兼容构建。

不默认设计反向灌回 localStorage：容量上限可能使它无法完成。确需降级时先导出新库关键数据，验证旧端可恢复格式和容量，再另行设计受控转换。

正式发布前核对目标服务器确实可用 HTTPS 安全上下文，Web Locks 等能力按实际浏览器检测；不因能力缺失牺牲数据保护。上线验证分别记录构建已发布、浏览器已加载版本、迁移已完成、旧容量已释放四个状态。

## 二、实施任务

所有路径以 `packages/happy-app/` 为前缀。新增文件为拟定落点，实施前结合最新导入图复核。

### Task 1：存储清单与故障契约
- 文件：新增 `docs/validation/web-storage-inventory.md`；核对 `sources/sync/persistence.ts`、所有 MMKV/direct localStorage 调用。
- [ ] 记录每个键的真实生产者/消费者、归属、最大/典型大小及清理条件；包括未加载会话、非当前账号和旧标签页命名空间。
- [ ] 增加定向失败用例：配额满时缓存不影响实时功能，草稿失败保持输入，队列保存失败不发送网络请求。
- [ ] 在旧实现运行用例确认现有缺口，保留错误类别与调用链，不收集用户正文。
- 交付：完整 key 映射与关键写入调用者清单；未确认项明确标记，不凭截图下根因结论。

### Task 2：IDB 仓储与事务迁移
- 新增：`sources/persistence/webStateDatabase.web.ts`、`webStateTypes.ts`、`legacyWebStateMigration.web.ts` 及对应 `.test.ts`。
- 接口：实现设计约定第 4 节；`migrateLegacyWebState(scope: string): Promise<MigrationReport>`，报告只含状态、计数及错误类别。
- [ ] 先写失败测试：request 成功而事务 abort 不算保存；CAS 冲突；重复迁移；坏 JSON；源值迁移期间变化；目标已更新不被覆盖；localStorage 满时迁移标记仍能提交。
- [ ] 实现数据库、事务完成语义、迁移阶段与校验；关键旧键默认保留。
- [ ] 验证被阻塞升级、open 超时、versionchange 关闭连接；失败后可由用户重试。
- 交付：可重入迁移和类型化错误，无业务层伪同步替换。

### Task 3：启动水合与账号隔离
- 新增：`sources/components/appRoot/AuthenticatedBootstrap.web.tsx`、平台默认入口及测试。
- 修改：`sources/app/_layout.tsx`、`AuthenticatedRootLayout.tsx`、`sources/auth/accountRuntime.ts` 的必要边界；不重写认证。
- [ ] 先写导入顺序测试，保证 hydrate 完成前不构造依赖持久数据的业务 store。
- [ ] 实现 opening/migrating/hydrating/ready/error 状态与动态 import 边界。
- [ ] 验证 legacy 账号、未登录、账号切换中写入、退出时迟到事务、公共分享不打开私人库。
- 交付：迁移期间不出现默认空数据回写；原生入口保持既有行为。

### Task 4：草稿和关键队列完整异步化
- 修改：`sources/sync/persistence.ts`、`storage.ts`、`composeDraft.ts`、`firstSubmissionRuntime.ts`、`messageStagingQueue.ts`、`messageStagingQueuePersistence.ts`、`publicSessionShareQueuePersistence.ts` 及实际调用者。
- 新增：对应 `.web.ts` 平台仓储，按业务域拆分，避免复制整份 persistence.ts。
- 接口：关键保存返回 `Promise<void>` 或显式持久化结果；队列所有 commit 路径串行 await；原生同步保存通过适配得到相同完成契约。
- [ ] 先验证保存拒绝不清空输入、不启动网络；事务完成之前不能显示 saved/queued。
- [ ] 逐路径改造新增/编辑/撤回/恢复/发送/ACK，保留原 ID、barrier 和不确定状态。
- [ ] 验证附件保存成功后队列失败、队列移除成功后附件删除失败、ACK 接受后本地失败、刷新恢复不重复发送。
- [ ] 验证两个新版标签页编辑同一草稿发生冲突时两份内容均可恢复，旧标签页修改不会被清理。
- 交付：关键内容不再依赖 localStorage 的可用空间；未提交操作清晰可恢复。

### Task 5：剩余业务域、缓存预算和诊断
- 修改：`persistence.ts`、`sessionWarmCache.ts`、`projectWorkspaceCache.ts`、继续会话/评注及 Task 1 确认的其他业务域；复用 `localHistoryStore.ts` 现有库边界。
- 新增：`sources/persistence/webStorageBudget.web.ts`、`webStorageDiagnostics.web.ts` 及测试；诊断界面按现有 Developer 入口和设计规范落点。
- [ ] 先写预算与清理测试：只删可重建项、保留关键内容、quota 后最多重试一次、损坏记录不让全站崩溃。
- [ ] 迁移剩余域，设置/主题投影限定字段与长度，保留最小 localStorage 白名单。
- [ ] 加入 BroadcastChannel 失效通知和能力缺失时的动作触发校验，不增加轮询。
- [ ] 完成诊断、仅清缓存与导出；导出可重新读入验证，正文不出现在日志。
- 交付：全 key 清单逐项标记已迁移/有意保留/未覆盖理由，无“所有存储已迁移”的模糊结论。

### Task 6：回归与交付门禁
- [ ] 定向测试命令：`pnpm --filter happy-app exec vitest run <本次新增测试和受影响现有测试路径>`；实施时将占位替换成最终文件清单。
- [ ] 静态检查：`pnpm --filter happy-app typecheck`，受影响现有草稿、队列、账号、文件工作区与暖缓存测试全部通过。
- [ ] Web 构建使用当前 package.json / CI 的实际入口，记录命令和 revision；检查 OTA 分类，不因声称 Web 专用跳过共享代码影响。
- [ ] 按 ego-ops → ego-browser 在独立测试 origin/测试账号验证真实 IndexedDB，使用测试数据填满 localStorage，不填满用户原站点。
- [ ] 真浏览器矩阵：Chromium 及 Safari/WebKit 真实浏览器；覆盖满额迁移、刷新、关闭重开、两个新版标签页、新旧标签页并存、禁用存储、升级 blocked、离线编辑后恢复连接、用户清缓存。
- [ ] 明确覆盖大于 5 MiB 的业务数据在 IDB 提交并重开后恢复；不等同于保证任意大小附件或任意磁盘都可写。
- [ ] 代码级原生适配回归通过；如共享运行逻辑变化需进一步 Android 验证/OTA，则执行前读取 android-ops 和发布规则，不以 Web 测试替代真机证据。
- [ ] 检查根工作区 clean main；文档、实现、验证结果仅留在独立 worktree。提交/推送/合并与发布按后续明确授权执行。

## 三、最终验收标准

1. 测试站 localStorage 满额时，可打开应用，完成旧数据导入，并持久保存新草稿和队列；保留白名单写入失败有专属恢复提示。
2. 迁移任一步中断后重开，原数据或已提交新数据仍可恢复；坏数据、未知归属和冲突均不静默丢弃。
3. 保存失败不会伪装成功；缓存失败不阻断正常实时会话，关键失败不自动清除输入或重发消息。
4. 两个新版标签页一致性、旧端并存保护、账号隔离和退出清理均有对应测试证据。
5. 缓存增长受预算控制，用户只清缓存不会丢草稿、待发内容、附件原件或凭据。
6. 数据迁移完成与旧键安全退役分别验收，旧客户端回退限制写入交付说明。
7. 原生持久化仍兼容，无额外 Cloudflare 服务、后台轮询或新发布 origin。

## 四、规模判断与未完成事项

这是中等偏大的 Web 存储改造，不是替换几个 API。核心工作量在启动依赖和队列同步契约；完整范围超过“只搬草稿”方案。先完成 Task 1 后按真实调用者数量估工，不在未验证导入图和测试环境前承诺具体工期。

本轮已修订并实施；具体完成与未验证边界见 `docs/validation/web-indexeddb-migration.md`，不得把计划中的验收项当作已通过。

## 五、实施收敛记录（2026-11-22）

- 启动门禁实际落在 `index.ts` → `bootstrapStorage.web.ts`，早于 unistyles 和 Router；仅在 AuthenticatedRootLayout 增加 await 不足以保护导入顺序。
- records 第一版保留旧物理 namespace + key 粒度，cache 标志与内容同表，迁移/冲突/撤销状态独立 stores；不在此次同时拆分所有业务 map。整个 map 使用 revision CAS，冲突不覆盖。
- 保留同步水合读取与草稿观察式写入，以全局 pending/failed/recovery 面板明确持久状态；首次提交、消息入队、继续会话、分享任务等外部副作用前必须等待提交。原生仍直接 MMKV，完成适配不改变原生存储格式。
- 迁移来的旧消息队列和未完成分享任务标记为待核对，绝不因为复制成功就自动派发。新版分享队列另持生命周期所有权锁，无锁时不自动接管。
- 增加 namespace/account/record 撤销 epoch。显式退出/清理同事务移除恢复正文并保留无正文标记；撤销后的迟到写入直接拒绝，不再保存成 conflict 副本。
- 新库的缓存预算为 32 MiB、单记录 2 MiB，真实 quota 只清可重建缓存并重试原事务一次。其他历史/附件库保持既有实现，不能宣称整个 origin 均受这 32 MiB 预算控制。
- Developer 页增加 Web 存储计数/估算用量及只清理可重建缓存入口。原始草稿默认保留；导出包含私人数据，需用户点击并确认。
- 仅在隔离测试 origin 验证满额/大草稿与完整未登录应用启动；没有修改用户正式浏览器数据，没有正式发布。
