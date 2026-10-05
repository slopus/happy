# Paws 公共 AI 服务与狗头军师首接实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将狗头军师的默认服务和个人 Paws 服务接入同一套公共 SDK 与服务面板，验证后供其他应用复用。

**Architecture:** Paws 管理稳定的服务入口与版本化执行配置。SDK 统一操作语义，保留平台后端与个人浏览器加密通道。公共控制器和 DOM 面板不依赖狗头军师业务。

**Tech Stack:** TypeScript、现有 Paws Server/Fastify/Prisma、Paws daemon、Codex/Claude CLI、Paws React Native/Web、原生 DOM、狗头军师 Node.js 24/SQLite/SuperTokens；现有 Vitest 与 Node test；网页验收使用 Ego。

**Spec:** [已认可设计](../specs/2026-10-05-paws-shared-ai-service-design.md)。执行前同时读取设计与本计划。

## Global Constraints

- 首期只接入狗头军师。验证通过后再推广。
- 不增加积分、套餐、用户调用配额或统一网站登录系统。
- 保留已有鉴权、输入大小限制和资源保护，不将“无业务限额”解释为无限并发。
- 个人通道的解密密钥不经过应用后端。平台凭据不下发到浏览器。
- 修改默认值只影响新对话。原对话继续使用原绑定。
- 认证 token 更新仍跟随同一账号的最新凭据版本，不能固定旧 token。
- 首期不加入“快速/深入”的跨引擎自动映射。
- 既有直接 API 连接暂保留兼容，不新增此类连接。
- 不静默切换账号、引擎、设备或付费方。问答权限不包含终端、文件系统或浏览器操作。
- 当前只制定计划。实施、包发布、生产切换分别记录授权和结果；不将计划完成写成产品完成。

## Review Focus

1. 创建对话恰逢管理员修改默认配置：只绑定一个完整修订，不混用设备、账号与模型。T2 测试。
2. 请求已接受但响应丢失：恢复同一回合，不生成第二次模型调用。T4/T5 测试。
3. 两个标签页切换来源或撤销连接：不把旧流更新写到新对话，不泄露另一连接的历史。T6/T9 测试。
4. 同一设备的 Claude 登录被换成另一身份：旧绑定不能误用新身份；无法核验时明确阻止继续。T3 测试。
5. 旧对话没有可信的账号/模型记录：不套用当前默认，也不自动向另一服务传历史。T8 测试。

## 阶段与依赖

| 阶段 | 任务 | 可验收产物 | 进入下一阶段的条件 |
| --- | --- | --- | --- |
| P0 基线 | T0 | 隔离工作区、发布基线、真实环境清单 | 当前线上功能及代码差异已识别 |
| P1 服务核心 | T1–T4 | 版本化配置、受限授权、双引擎执行 | 协议、账号归属与故障测试通过 |
| P2 公共接入 | T5–T6 | SDK、无界面控制器、DOM 面板 | 两通道同契约；本地包可复用 |
| P3 管理与首接 | T7–T9 | Paws 管理入口、狗头军师迁移 | 新调用走 Paws，历史和登录正常 |
| P4 验收与试点 | T10–T11 | 真机证据、可安装包、试点发布及回退记录 | A1–A12 与机主日常使用通过 |

T1 → T2/T3 → T4 → T5 → T6 → T7/T8 → T9 → T10 → T11。T2 与 T3、T7 与 T8 可在协议冻结后分别工作，但不得同时修改公共接口。任务是否交给子代理由用户选择的执行方式决定。

每个任务均先写行为测试，确认因目标能力缺失而失败，再实现并通过测试。每个任务单独提交，只暂存该任务文件。不要 `git add .`。以下测试命令为实施时执行，本轮未运行。

## 目录与命名

`P/` 表示实施时创建的 Paws sibling worktree，建议名 `happy--shared-ai-services`；不是保留干净 main 的根目录。`A/` 表示狗头军师独立 worktree，建议名 `relationship-advisor--paws-services`。文件路径均相对对应工作区。

现有代码入口已核对。标为“新增”的文件属于计划，不表示已经存在。实施时如主线已移动文件，先记录等价入口，不创建平行实现。

| 位置 | 责任 |
| --- | --- |
| P/packages/happy-wire/src/aiServices.ts（新增） | 类型、协议版本和校验 |
| P/packages/happy-server/sources/app/aiServices/（新增） | 配置、应用登记、绑定、授权、审计 |
| P/packages/happy-cli/src/daemon/appDelegation/ | 双引擎能力与受限执行 |
| P/packages/paws-agent/src/services/（新增） | 统一 SDK、通道适配、连接控制器 |
| P/packages/paws-connect-ui/（新增） | 可复用 DOM 面板与样式 |
| P/packages/happy-app/sources/ | Paws 管理、网页和手机授权 |
| A/paws-service.mjs（新增） | 平台后端 SDK 适配与历史映射 |
| A/public/ai-service.js（新增） | 狗头军师接入公共组件的薄适配 |

## P0：建立可回退基线

### Task 0: 冻结试点基线

**Files:** 新增 `P/docs/verification/shared-ai-services-baseline.md`、`A/docs/verification/paws-services-baseline.md`。不修改运行目录。

**Interfaces:** 产出包含 Git SHA、运行版本、协议版本、现有登录/历史/图片/分享功能、CLI 能力的基线记录，不含凭据。

- [ ] 按 `using-git-worktrees` 和各仓库指令建立独立工作区；核对工作树、当前主线和线上发布清单。保护所有已有未提交改动，不重置或搬运无关工作。
- [ ] 从包含 `f0dbfffea628506479810c9422489f664a0e78c3` 功能的最新有效基线开始狗头军师开发；主线缺少线上功能时先整理差异，不从旧工作区覆盖线上。
- [ ] 只读核对两个 Codex 账号、Claude 登录与 CLI 版本、设备在线状态。只记录账号引用。Claude 不可用时记录 A4 尚不能完成，不伪造成功。
- [ ] 运行现有受影响模块测试和狗头军师 `npm test`；用已有证据和必要只读检查确认当前功能。分类既有失败。
- [ ] 提交两个基线记录，产出各仓库后续验证命令与部署入口。

## P1：服务核心

### Task 1: 冻结公共契约

**Files:** 新增 `P/packages/happy-wire/src/aiServices.ts`、`aiServices.test.ts`；修改该包现有导出与 `src/appChat.ts`，保留旧协议解析。

**Interfaces:** 定义 `ServiceRef`、`ServiceConfig`、`ServiceRevision`、`ExecutionBinding`、`CapabilityCatalog`、`TurnRecord`、`TurnResult`、`ServiceError`、`AppPolicy`、`ServicePrincipal`、`GrantReceipt`。`TurnResult` 是带最终状态的 `TurnRecord`；`ServicePrincipal` 区分 owner、平台授权与个人授权；`GrantReceipt` 包含授权 ID、范围和仅在签发时返回的凭据。新增协议标识为 `ai-services/1`，与旧授权数字协议分开协商。

- [ ] 测试 `parseServiceConfig`：Codex 只接受 `accountRef={kind:'codex-profile',id}`；Claude 只接受 `{kind:'device-identity',machineId,identityId}`；二者不得串用。`reasoning={mode:'default'}` 或 `{mode:'explicit',value:string}`，拒绝空显式值。
- [ ] 定义 `ExecutionBinding` 字段：`id/appId/serviceId/revision/machineId/engine/accountRef/requestedModel/reasoning/permissions`。`TurnRecord.actual` 单独保存实际模型与强度；未上报为 null，不能复制请求值冒充实测。
- [ ] 为 `AppPolicy` 定义 origin、能力和可信业务提示词版本引用。提示词可以改变业务回答，不能改变权限、账号或执行参数；客户端不能注册任意 appId 或上传受信系统策略。
- [ ] 定义统一错误码与 terminal 状态；写测试验证旧 `codex:chat` 不自动升级，未知协议返回 `protocol-incompatible`。
- [ ] 执行 `pnpm --dir packages/happy-wire test`，类型和兼容测试通过后提交。

### Task 2: 服务配置、应用登记与会话绑定

**Files:** 修改 `P/packages/happy-server/prisma/schema.prisma`；新增迁移、`sources/app/aiServices/{store,registry,bindings}.ts`、`store.spec.ts`、`sources/app/api/routes/aiServiceRoutes.ts` 及路由测试；在现有 API 初始化入口注册。

**Interfaces:** `createService(ownerId,input): Promise<ServiceRef>`；`updateService(ownerId,id,expectedRevision,config): Promise<ServiceRevision>`；`resolveBinding(principal,appId,serviceId,overrides): Promise<ExecutionBinding>`。

- [ ] 测试修订并发冲突、跨 owner 读取、跨 app 引用及默认更新竞态。相同 `expectedRevision` 的两次更新仅一次成功；创建会话得到完整的旧修订或新修订。
- [ ] 新增服务、不可变修订、应用登记、授权关系和执行绑定表。已有账号表只引用，不复制认证。采用新增 schema；回退不删数据。
- [ ] 加入 owner 管理路由 `/v1/ai-services` 与 `/v1/ai-services/:id`，以及应用受限的 `/v1/apps/services`。注册表预置狗头军师；第二应用由管理员登记，不接受前端任意 origin。
- [ ] 解析配置时校验账号归属、设备范围、能力和覆盖权限。账号删除阻止新调用；凭据刷新保持原账号身份。
- [ ] 执行 `pnpm --dir packages/happy-server exec vitest run sources/app/aiServices/store.spec.ts sources/app/api/routes/aiServiceRoutes.spec.ts`；用仓库既有迁移测试方式核对老库升级和恢复；提交。

### Task 3: 真实能力目录与双引擎执行

**Files:** 新增 `P/packages/happy-cli/src/daemon/appDelegation/{serviceCapabilities,executionBinding,applicationPolicy}.ts` 及对应 `.test.ts`；修改 `restrictedCodex.ts`、`restrictedClaude.ts`、`appChatWorker.ts`。保留 `advisorPrompt.ts` 供旧协议兼容。

**Interfaces:** `readServiceCapabilities(binding): Promise<CapabilityCatalog>`；`executeBoundTurn(binding,input,signal,onEvent): Promise<TurnResult>`。`CapabilityCatalog` 包含账号身份引用、观察时间、目录完整性、模型、图片能力与原生推理设置。

- [ ] 测试不支持的推理参数被拒绝、离线缓存不能执行、未知实际模型返回 null、未授权工具被拒绝、Claude 登录身份改变导致 `account-identity-changed`。
- [ ] Codex 使用绑定账号读取模型目录，并复用已有凭据刷新归属。Claude 使用经验证的登录身份和运行时能力；有限别名标记 `limited`，不支持推理选择时仅支持 default。不能验证原身份时阻止原会话续用。
- [ ] 去掉新协议中的狗头军师专用提示词依赖。`applicationPolicy` 按登记的 appId/策略修订加载可信业务提示词；旧协议继续使用原策略。消息和图片仍为非可信输入。
- [ ] 请求的模型/推理参数由执行器校验后传入；记录实际上报，不允许 SDK 或网页假定已生效。保留工具禁用、隔离运行目录、取消和凭据刷新恢复。
- [ ] 执行 `pnpm --dir packages/happy-cli exec vitest run --project unit src/daemon/appDelegation`，相关类型检查通过后提交。真实双引擎验证在 T10 完成。

### Task 4: 两种来源的受限授权与回合持久化

**Files:** 修改 `P/packages/happy-server/sources/app/appDelegation/appDelegation.ts`、`sources/app/api/routes/appDelegationRoutes.ts` 及现有测试；新增 `sources/app/aiServices/{grants,turns}.ts`、`grants.spec.ts`、`turns.spec.ts`；修改 T3 worker 对新协议的领取/回报入口。

**Interfaces:** `issueServiceGrant(ownerId,appId,serviceId,scope): Promise<GrantReceipt>`；`startBoundTurn(principal,bindingId,requestId,envelope): Promise<TurnRecord>`；`readBoundTurn`、`cancelBoundTurn`。签发凭据仅返回一次，服务端存摘要及授权范围。

- [ ] 测试受限凭据不能访问普通账号 API；平台浏览器响应不含平台 secret；新修订引入未授权账号/引擎时返回 `consent-required`，不降级成本地认证。
- [ ] 平台授予应用后端专用凭据及消息密钥；个人授权保持浏览器和执行器加密封装。增加 service/binding/app/protocol 的认证绑定，不把两通道变成同一明文代理。
- [ ] 将新协议能力独立公布，旧扫码、有效期和撤销继续可用。通用化旧 appId 之前先校验注册表，保留既有精确来源和所有权检查。
- [ ] 测试同一 requestId 重试只产生一回合；取消与完成竞态只有一个最终状态；租约丢失不重跑；撤销后 worker 停止，已接受上游工作不伪称已撤回。
- [ ] 复用现有消息存储、序号和事件出口，增加游标恢复读取。执行 `pnpm --dir packages/happy-server exec vitest run sources/app/aiServices sources/app/appDelegation sources/app/api/routes/appDelegationRoutes.spec.ts`；提交。

## P2：公共 SDK 与交互

### Task 5: 统一 SDK 与连接控制器

**Files:** 新增 `P/packages/paws-agent/src/services/{client,controller,platformTransport,personalTransport,storage}.ts` 及同名 `.test.ts`；修改 `src/node.ts`、`src/browser.ts`、包 exports。新入口不得破坏旧 `PawsAgentClient`。

**Interfaces:** `createAIServiceClient({appId,transport}): AIServiceClient`；它提供设计中的 `services.list/capabilities.read/connections.authorize/conversations.create/turns.start/observe/read/cancel`。`createServiceController(client,storage)` 提供 `getState/subscribe/selectSource/connect/disconnect/setOverrides/dispose`。

- [ ] 用同一契约测试套件执行平台和个人通道：同一输入得到相同状态结构，凭据不能跨来源；模拟“提交成功但响应丢失”，恢复原 requestId。
- [ ] 平台 Node 适配器持有应用受限授权；浏览器平台适配器只调用本应用后端。个人适配器复用受限授权和加密，不转发密钥给应用后端。
- [ ] storage 默认 sessionStorage，显式 remember 使用 IndexedDB。按应用 origin、应用登录主体和连接 ID 隔离；退出清理、撤销、忘记本地分别实现；跨标签页使用 BroadcastChannel 通知失效。
- [ ] 测试刷新恢复、不支持 IndexedDB 时回退标签页存储并提示、断线取消待确认、监听释放、无后台空轮询。
- [ ] 执行 `pnpm --dir packages/paws-agent test` 和 `pnpm --dir packages/paws-agent typecheck`；验证 browser 构建不包含 Node 模块或平台凭据；提交。

### Task 6: 公共 DOM 面板

**Files:** 新增 `P/packages/paws-connect-ui/{package.json,src/index.ts,src/panel.ts,src/panel.css,src/panel.test.ts}`；包与测试配置按 workspace 现有方式接入。

**Interfaces:** `mountServicePanel(element,{controller,appearance,onSourceSelected}): {destroy():void}`。复用 T5 状态和 T1 错误码，不直接调用 Paws HTTP。

- [ ] 测试服务切换时忽略前一来源的异步事件、销毁后解除订阅、模型目录变化清除失效覆盖项、仅允许的参数可选择。
- [ ] 实现来源选择、同设备授权跳转/二维码、默认配置、高级设置、状态与详情。连接页不重复询问已经配置好的模型和强度。
- [ ] 加入键盘焦点、弹层关闭后焦点恢复、手机底部弹层、CSS 变量和清晰的状态操作。源码不含固定狗头军师 appId、提示词或配色。
- [ ] 执行 `pnpm --dir packages/paws-connect-ui exec vitest run` 与该包 build；使用 Ego 检查本地合成数据的桌面/手机页面，按 Happy 要求上报关键状态。远程静态草图仅经 Happy preview 分享。
- [ ] 提交组件和合成 fixture；不发布 npm。

## P3：管理入口与狗头军师

### Task 7: Paws 管理与统一授权页

**Files:** 新增 `P/packages/happy-app/sources/sync/apiAIServices.ts`、对应测试、`sources/components/aiServices/{ServiceList,ServiceEditor,ServiceConsent}.tsx` 及同名 `.test.tsx`、`sources/app/(app)/settings/ai-services.tsx`；修改 `settings/index.tsx`、`apps/authorize.tsx`、`sync/apiAppDelegation.ts` 与相应测试。

**Interfaces:** UI 消费 T2 管理 API、T3 能力目录、T4 授权；不创建第二份配置 store。组件表单提交必须携带 expectedRevision。

- [ ] 测试配置更新冲突保留未保存输入；默认值变更提示“仅影响新对话”；未授权引擎需要补充确认；未知 Claude 额度显示“未知”。
- [ ] 实现服务列表、编辑、应用引用、最近调用与实际配置。复用现有账号/设备入口，不复制账号登录流程。
- [ ] 授权页一次展示服务、设备/账号范围、引擎和权限，默认配置预填；网页与手机使用同一协议。记住连接与授权有效期分开表达。
- [ ] 执行 `pnpm --dir packages/happy-app exec vitest run sources/sync/apiAIServices.test.ts sources/components/aiServices` 和受影响授权页测试；按项目要求类型检查。Ego 验证 Web；手机授权实测留到 T10。
- [ ] 提交；原生/OTA 发布仍遵循项目当前 runtime 契约，不从本计划复制版本号。

### Task 8: 狗头军师平台通道与旧历史迁移

**Files:** 新增 `A/paws-service.mjs`、`A/service-migration.mjs`、`A/test/paws-service.test.mjs`、`A/test/service-migration.test.mjs`；修改 `server.mjs`、`package.json`、锁文件。保留 `agent.mjs` 和 `direct.mjs` 作为受控兼容路径。

**Interfaces:** `createPawsServiceAdapter({client,db,appId,serviceId})` 提供 `createConversation/startTurn/readTurn/cancelTurn`；`ensurePawsBinding(db,conversationId,provenance): Promise<BindingOrConsentRequired>`。后端核对登录主体和对话归属后调用。

- [ ] 测试默认新对话经 mock SDK，直接 spawn 为零；数据库中重复迁移只生成一个 binding；相同请求重试不重复计入消息或执行。
- [ ] 新增会话服务绑定和 turn 映射表，不覆写旧历史。旧对话有可信配置时保留原账号/模型；缺失时返回需选择状态，未选择前不传历史。
- [ ] 加入 `ADVISOR_AI_SERVICE_MODE=legacy|paws`，服务端 Paws 凭据仅从私有部署配置读取。每段对话存 transport 归属，不根据全局开关误路由已开始的回合。
- [ ] 保留邮箱登录、业务提示词版本、咨询方式、图片、分享和 direct 已存连接。关闭创建新 direct 连接的入口与后端写入操作；已有 direct 连接仍可验证/使用，标明未纳管。
- [ ] 执行 `node --test test/paws-service.test.mjs test/service-migration.test.mjs` 和 `npm test`；提交。默认部署值仍保持 legacy，未到 T11 不切线上。

### Task 9: 狗头军师接入公共面板

**Files:** 新增 `A/public/ai-service.js`、`A/test/ai-service.test.mjs`；修改 `public/chat.js`、`public/index.html`、生产前端构建入口、`scripts/build-paws-sdk.mjs`、`DESIGN.md` 与受影响 UI 测试。

**Interfaces:** 业务层只消费 T5/T6；`ai-service.js` 映射咨询角色、应用历史 ID 和已登录主体，不实现第二份连接状态机。

- [ ] 测试切换来源不携带旧草稿/历史，运行中不能错误切流，已有对话继续使用其绑定，logout 清除本地连接但不自动删远端历史。
- [ ] 输入框显示“AI 服务：平台提供/我的 Paws”，高级设置默认收起；记住连接显式选择。旧 direct 连接放在兼容入口，不伪装成 Paws 服务。
- [ ] 使用固定版本本地 tarball 安装公共包，替换从 Paws checkout 源码临时打包的脚本；保留旧授权读取所需的版本适配。
- [ ] 执行 `npm test`，构建真实产物；用 Ego 检查登录、来源切换、历史、图片、停止、刷新和移动布局。按项目设计规则更新 `DESIGN.md`。
- [ ] 提交狗头军师接入，记录公共 tarball 哈希与提交。只含合成数据的演示不代替生产数据迁移验收。

## P4：复用验证与受控试点

### Task 10: 真实能力与第二应用验收

**Files:** 新增 `P/examples/ai-service-smoke/{package.json,server.mjs,index.html}`、`P/docs/verification/shared-ai-services.md`、`A/docs/verification/paws-services.md`。fixture 不含真实凭据。

**Interfaces:** 第二应用消费与狗头军师相同哈希的打包产物，仅提供 appId、授权配置、业务提示词与输入；不直接导入公共包源码。

- [ ] 在隔离测试身份/服务中登记第二应用，验证它不能访问狗头军师的对话；记录该应用代码仅包含业务胶水。A10、A12。
- [ ] 分别用两个真实 Codex 账号和一个可用 Claude 身份执行最小回合，核对实际模型、推理设置及上游身份。用少量明确请求验证，不以目录可见代替执行成功。A3–A5。
- [ ] 实测桌面授权跳转、手机扫码确认、范围内切换不重扫、退出/记住/撤销。A6、A11。只有手机网页测试不等于原生手机确认通过。
- [ ] 注入断线、离线、失效、取消竞态和默认修订切换，核对 A1、A2、A7–A9；同一回合的重复执行数必须为零。
- [ ] 将 A1–A12 标为通过/失败/未执行，附提交、版本和证据。修复后只重跑受影响项。Claude 或手机条件缺失时保留未执行，不进入“全部验收通过”。提交记录。

### Task 11: 公共包发布与狗头军师试点

**Files:** 更新公共包版本/变更记录、`A` 固定依赖与部署说明；新增 `A/docs/verification/paws-services-rollout.md`。版本号在发布时按已发布版本和仓库发布策略确定，不在本计划假定。

- [ ] 确认 T10 通过，并形成可审阅发布清单：各提交、迁移、兼容矩阵、旧版本恢复入口、正在运行的回合和历史备份。包发布及生产动作按用户后续授权执行。
- [ ] 先向后兼容 Server/schema，再执行器，再 Paws 管理/授权界面；新能力未全就绪时禁用新协议入口，旧服务继续可用。
- [ ] 按仓库流程发布版本化 SDK 和公共组件。由 tarball 测试产物的相同提交生成发布包，检查文件清单与哈希；狗头军师锁定精确版本并重建，不复制旧构建。
- [ ] 待旧回合结束后，仅开启狗头军师 paws 模式。核对真实登录、已有历史、图片、默认服务、个人服务和直接 API 兼容入口。
- [ ] 如需回退，将新对话恢复 legacy；已绑定 Paws 的对话仍从 Paws 读取/取消。不删除新增表，不重放正在处理的消息。出现授权或凭据泄露类问题时优先撤销相关授权，再说明受影响功能。
- [ ] 机主完成一次完整日常咨询，确认回复、历史恢复和执行详情。没有机主反馈时标记“技术验收通过，日常使用待确认”，不自动宣布推广。
- [ ] 提交最终验证与版本记录。后续知学/缠论推广另列批次；MISS 采集和 Mac Ops 另做工具能力设计。本计划不自动修改其他站点。

## 覆盖核对

| 设计内容 | 实施任务 |
| --- | --- |
| 稳定服务入口、配置修订、账号纳管、调用记录 | T1–T4、T7 |
| 双引擎、动态能力、推理强度、真实配置 | T3、T5、T10 |
| 平台默认服务、个人授权、连接持久化 | T4–T7、T9 |
| 公共模块、DOM/React 可复用、手机 Web | T5、T6、T10 |
| 旧历史、直接 API 例外、兼容回退 | T8、T9、T11 |
| A1/A2/A7/A8/A9 | T8–T11 |
| A3/A4/A5/A6/A10/A11/A12 | T3–T7、T10 |
| 无新增业务限额、无 SSO、无自动推广 | 所有任务的全局约束及 T11 |

## 交接状态

2026-10-05：设计已认可，分阶段计划已写入并自审。任务均未执行。本轮没有建立开发 worktree、安装依赖、发布包、迁移数据库或切换账号。

建议使用逐任务实现与独立评审，因为服务端、SDK、执行器和两个应用入口共用协议。用户也可选择本会话顺序实施，阶段末统一评审。用户审阅本计划并选择执行方式后，再开始 P0。
