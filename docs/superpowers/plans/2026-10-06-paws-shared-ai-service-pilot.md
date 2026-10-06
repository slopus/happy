# Paws 真实验收、狗头军师试点与推广 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. 用户已选择逐任务实施、独立评审。本文不重新实施已完成的 T0–T11。

**Goal:** 将已完成本地评审的公共 AI 服务，通过真实验收和狗头军师试点，形成其他应用可复用的接入流程。

**Architecture:** 应用统一使用 Paws SDK 和公共连接面板。平台通道保留服务端受限授权，个人通道保留浏览器端密钥。服务配置集中管理，已创建对话的执行绑定不变。

**Tech Stack:** 现有 Paws Server、daemon、Codex/Claude 执行适配、paws-agent、paws-connect-ui；狗头军师 Node/SQLite；现有 Web/Android 发布工具。沿用仓库锁定版本，不在计划阶段选择新依赖。

**Spec:** `docs/superpowers/specs/2026-10-05-paws-shared-ai-service-design.md`。设计中的“未实现”属于历史状态；当前基线以 `docs/verification/shared-ai-service-review/README.md`、`docs/releases/shared-ai-services-candidate.json` 和两个仓库的实际 HEAD 为准。后续修订以已记录的实施决策为补充，不恢复被明确排除的 Claude API-key 等未验证能力。

## Global Constraints

以下引文保留原设计措辞：

- “主要用户是机主自己。”
- “应用默认使用机主提供的服务，也允许用户连接自己的 Paws。”
- “首期只接入狗头军师。验证通过后再推广。不增加积分、套餐、用户调用配额或统一网站登录系统。”
- “个人通道的解密密钥不经过应用后端。平台凭据不下发到浏览器。”
- “修改默认值只影响新对话。原对话继续使用原绑定。”
- “账号被删除、权限被撤销或模型不再可用时，原对话停止新调用，不回退到其他账号。”
- “在批准范围内换模型或推理强度无需重新扫码。”
- “未提供的 Claude 额度显示‘未知’。”

执行约束：

- 计划最初仅供审阅。2026-10-06 用户授权执行 Stage 1 / Tasks 1–2。Task 1 已独立评审；Task 2 已准备隔离环境与恢复点，真实执行器条件尚未满足。没有生产发布、生产迁移、账号切换或正式默认值调整。既有授权持续有效；需要尚未给出的外部操作授权时，先完成可审阅产物，再列出具体动作一次确认。
- 保留两个 sibling worktree 和 MISS 未提交工作。不重置主工作区，不复制旧构建产物上线。
- 所有同一 bindingId/requestId 的提交者共用一个持久化原子 ServiceStorage 命名空间。升级前停止或重载旧候选客户端。原请求仍能恢复时，不删除提交结论记录。
- 真实验收优先在独立、受信的验收环境完成。不得用生产启用来绕过验收前置条件。不能建立独立环境时，记录阻塞及所需资源，不擅自切生产。
- 不复制认证 JSON 或用机器默认账号冒充精确账号执行。真实登录由账号所有者在官方流程完成；不要索要账号密码或原始 token。
- 保留直接 API 兼容例外并标为未纳管。保留旧协议权限，不自动扩权。
- 浏览器只使用 Ego；原生手机必须在真实设备验证。手机宽度网页不替代原生确认。公开预览只放合成数据，不承载真实凭据。
- main 合并可能触发生产 Web/OTA。不能把“提 PR”“验收构建”和“合入并发布”视为同一个无副作用动作。
- 测试环境、自然发生的上游结果、合成故障和真实日常使用分别记录。不通过耗尽真实账号额度来制造故障。

## Review Focus

1. 验收环境误连生产账号默认值或数据库：Task 2 必须验证明确目标、隔离配置和退出后原环境不变。
2. 原生登录刷新后串到另一账号：Task 3 必须验证两个精确账号及刷新前后的归属，不只检查模型回答内容。
3. 手机授权扩大原范围或丢失旧密钥：Task 4 必须验证范围内免扫码、范围外再确认、记住/退出/撤销及历史隔离。
4. 升级期间混用旧客户端或多实例独立存储：Task 5 必须验证共享存储、两种并发时序和重启恢复，不靠换 requestId 解锁。
5. 回退将已接收请求交给旧执行器重跑：Task 5 演练，Task 7 复核；始终使用原绑定读、取消和恢复。

## 当前基线与阶段门槛

本地交付基线：Paws `8e040a7683b90bde77ad3974391ba0f019d4ed53`；狗头军师 `21a2c583e03c80f44a030f05e70b769bc2d65277`。执行时重新读取，不把此值当作远端最新主线。

已完成：公共协议、管理页、SDK/控制器/面板、狗头军师适配、第二应用验证、独立评审和本地恢复/并发回归。

未完成：A1/A3/A4/A5 真实执行，A6 真实个人与原生手机授权，A9 完整旧链路，机主日常使用，生产准备和发布。既有两项高等级依赖告警仍需评估。

| 阶段 | 任务 | 交付 | 进入下一阶段的条件 |
| --- | --- | --- | --- |
| 1. 固定基线和受信环境 | 1–2 | 环境清单、独立验收环境、恢复点 | 来源、版本、身份和存储均可核对；原生产环境不变 |
| 2. 验证真实执行 | 3 | 两个 Codex 账号与 Claude 的最小回合证据 | 精确账号、参数和凭据刷新可核对；不静默换账号 |
| 3. 验证完整使用链路 | 4–5 | 个人授权、历史兼容、并发恢复和回退记录 | A1–A12 按约定范围逐项有证据；阻塞项清零 |
| 4. 狗头军师单应用试点 | 6–7 | 确切发布包、上线记录、机主一次完整日常使用 | 上线复核和回退路径有效；机主确认可用 |
| 5. 固化复用交付 | 8 | 接入说明、最小示例、公共交互约定 | 新应用无需复制授权、模型配置或加密逻辑 |
| 6. 逐站推广 | 9 | 网站映射和各站接入计划 | 每站确认范围后单独接入和验收 |

依赖：1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9。已完成的本地实现是输入，不再安排重复开发。每个 Task 都有独立评审；纯文档/运维任务按证据验收，不为了形式新增实现镜像测试。

## 文件与交付结构

P 表示 Paws worktree；A 表示狗头军师 worktree。Stage 1 已创建 baseline.md 和 environment.md。其余新文件仍待对应任务执行。

| 文件 | 责任 |
| --- | --- |
| P `docs/verification/shared-ai-pilot/baseline.md` | 代码、包、待验收项和环境别名 |
| P `docs/verification/shared-ai-pilot/environment.md` | 脱敏的验收环境与恢复步骤 |
| P `docs/verification/shared-ai-pilot/native-execution.md` | 真实账号、引擎、参数与额度证据 |
| P `docs/verification/shared-ai-pilot/authorization.md` | 桌面和原生手机授权结果 |
| A `docs/verification/paws-services-pilot.md` | 历史、故障、回退和日常使用结果 |
| P `docs/releases/shared-ai-services-candidate.json` | 唯一候选包、版本、哈希、迁移与放行状态 |
| P `docs/releases/shared-ai-services.md`；A `docs/verification/paws-services-rollout.md` | 更新现有发布与回退步骤，不另建冲突流程 |
| P `docs/ai-services-integration.md`；`examples/ai-service-smoke/README.md` | 可复用接入说明和已有最小示例 |
| P `docs/verification/shared-ai-pilot/adoption-map.md` | 其他网站到仓库、设备和账号的核实映射 |

公开记录只放设备/账号别名、状态、时间、脱敏引用和非敏感哈希。实际账号标识、授权 receipt、凭据和私有备份路径留在受限运维存储；文档只记录其引用。

### Task 1: 固定候选基线与待验收清单

**Files:** Create P `docs/verification/shared-ai-pilot/baseline.md`；Read 两个仓库 AGENTS/发布规范、当前候选和最终评审。

**Interfaces:** Consumes 已评审提交与 tarball；Produces 每仓 HEAD/branch、包哈希、真实验收状态、现有部署来源、未处理告警清单。

- [x] 读取两个工作区与远端配置；核对执行时主线和线上版本，记录未知值，不把功能分支 HEAD 当线上 SHA。
- [x] 对照候选清单验证两个消费者的 tarball、lockfile 和来源提交。包已变化时只重跑受影响检查。
- [x] 记录现有两项高等级依赖告警的包、影响路径和处理决定。需要修复时单独提交并验证，不混入账号迁移。
- [x] 将 A1–A12 当前状态抄入清单，保留真实/合成区别；列出 Claude 登录、原生设备、可信 API origin 和中央凭据链所需条件。
- [x] 运行 `node scripts/verify-shared-ai-migrations.mjs`，预期三项迁移路径和哈希通过。该命令不连接数据库。
- [x] 独立评审清单与当前文件是否一致，提交文档。

**通过条件：**候选来源清楚；未知部署信息和阻塞都有明确获取动作。没有重打包或发布。

### Task 2: 建立独立受信验收环境

**Files:** Create P `docs/verification/shared-ai-pilot/environment.md`；Read `docs/releases/shared-ai-services.md`、`packages/happy-server/prisma/migrations/`、既有受信部署说明。只有发现缺陷时修改对应部署配置，不新建通用部署平台。

**Interfaces:** Consumes Task 1；Produces 已验证的 Server/worker/管理客户端版本组合、验收数据库、HTTPS origin、受限应用登记、恢复点及私有配置引用。

- [ ] 选定一套独立验收 Server、数据库和执行器身份。把实际地址、目标进程及存储作用域写入私有清单，再提供脱敏审阅版。
- [ ] 明确 HTTPS 与手机可达性。不要把 localhost 或合成公开预览当作手机可访问的受信环境；新增外部环境须在实施授权范围内。
- [x] 在验收存储建立备份与恢复点，按原顺序应用既有前置迁移及三项新增迁移。实际演练恢复到单独验收库，不能覆盖生产库。
- [ ] 在隔离作用域通过正规流程登记账号和执行器。需要所有者登录或手机操作时给出具体入口；不迁移原始认证文件，不重启生产 daemon 来试验。
- [ ] 配置验收应用的明确 origin、业务提示词、chat/images 与平台受限授权。测试 origin 只登记在验收环境，不扩大生产允许来源。
- [ ] 核对真实 worker 在线、能力目录、授权作用域和原生产环境不变。若某项无法隔离，保持阻塞，先补齐受信环境条件。
- [ ] 独立评审隔离证据和恢复记录，提交脱敏文档。

**执行状态（2026-10-06）：**隔离 Server、53 项迁移、两份冷备份和独立恢复演练已通过。新管理 Web 和私有 HTTPS 已启动；正常信任的普通 DNS IPv4 请求通过。应用验收 origin、提示词和 chat/images 已核对。独立 Ego 的普通 HTTPS URL 返回 ERR_CONNECTION_CLOSED；浏览器受信入口仍未通过。真实所有者、worker、中央凭据链、平台授权与原生手机仍未验证，相关 checkbox 保持未完成。详见 `docs/verification/shared-ai-pilot/environment.md`。Task 2 未通过；独立评审待执行。

**通过条件：**独立环境能连通真实执行器；有可审计的精确账号凭据路径。此时仍未切换狗头军师生产默认服务。

### Task 3: 真实账号、引擎、模型和额度验收

**Files:** Create P `docs/verification/shared-ai-pilot/native-execution.md`；Reference `packages/happy-cli/src/daemon/appDelegation/{executionBinding,serviceCapabilities,restrictedCodex,restrictedClaude,nativeServiceErrors}.ts`与 `packages/paws-agent/src/services/`。发现问题才修改源文件及相应已有测试。

**Interfaces:** Consumes Task 2 的服务与授权；Produces A1/A2/A3/A4/A5 的实际绑定/回合证据及上游额度快照来源。

- [ ] 两个 Codex 账号各完成一个最小真实回合。对照绑定、凭据归属和执行记录，不用回复里的自我介绍证明账号或模型。
- [ ] 验证同一账号凭据刷新后仍属原账号。不得人为破坏生产认证；使用受信验收链的正规刷新过程。未观察到刷新时该子项保持未完成。
- [ ] Claude 登录后完成最小真实回合；未登录显示不可用。仅验收适配器能够验证的身份和模型别名，不增加任意 API-key 支持承诺。
- [ ] 从真实能力目录选择支持的模型和推理设置，核对传入参数及原生确认；不支持值被拒绝。上游未报告的 actual 字段保持 null，分别记录“已传入”和“已观察”。
- [ ] 修改验收服务默认配置：新对话使用新值，旧对话保持原绑定。验证失败不切账号、引擎或付费方。
- [ ] 读取每个账号的可用额度快照和观察时间。无法取得的值显示未知；不将应用用量估算当上游余额，不引入用户扣费系统。
- [ ] 发现实现缺陷时先用最小脱敏夹具复现，再修复并跑受影响测试。相关入口：`pnpm --dir packages/happy-cli exec vitest run --project unit src/daemon/appDelegation/executionBinding.test.ts src/daemon/appDelegation/serviceCapabilities.test.ts src/daemon/appDelegation/nativeServiceErrors.test.ts src/daemon/appDelegation/restrictedClaude.test.ts`。
- [ ] 独立评审回合证据与 A1–A5 判定，提交脱敏记录。

**通过条件：**两个真实 Codex 账号和真实 Claude 均有新协议证据。观察不到的实际参数不伪造；所请求设置准确传递。不通过自然语言猜测账号身份。

### Task 4: 桌面、手机和个人授权验收

**Files:** Create P `docs/verification/shared-ai-pilot/authorization.md`；Reference `packages/happy-app/sources/components/aiServices/`、`packages/paws-connect-ui/`、SDK personal/controller/storage 模块。

**Interfaces:** Consumes Task 3 的真实服务；Produces A6/A11/A12 证据与明确支持的客户端版本。

- [ ] 桌面进入狗头军师验收页面，默认平台服务可用且不要求使用者扫码。切到我的 Paws 后走真实授权入口。
- [ ] 用真实手机扫码，在匹配 runtime 的原生客户端确认。记录应用版本、更新 ID（如有）、授权目标及实际结果；不得写死新的 runtime 映射。
- [ ] 首次仅批准实际可用目标；可选择同时批准 Codex 和 Claude。范围内换模型/推理不重新扫码，未经批准的目标要求追加确认。
- [ ] 验证记住连接、重启浏览器、退出应用、过期或撤销。确认本地密钥清理与远端撤销不同，旧历史不串到其他来源。
- [ ] 用受限应用授权验证全账号 API、错误 origin、其他应用会话和终端能力均被拒绝。真实个人正文和密钥不得出现在宿主后端记录中。
- [ ] 用户已授权的浏览器验证使用 Ego；报告完成的关键步骤。若需要新原生构建/preview 发布，先准备匹配产物与可审阅批次，再按既有授权和仓库流程执行。
- [ ] 原生发布前运行 `pnpm --dir packages/happy-app exec vitest run sources/utils/otaRuntimeConfig.test.ts`；预期契约通过。该测试本身不证明手机授权成功。
- [ ] 独立评审授权范围、真实设备证据与未知项，提交记录。

**通过条件：**真实桌面和手机入口走同一授权语义，批准范围内无需重复配置；个人信任边界保持不变。

### Task 5: 狗头军师历史、故障和回退演练

**Files:** Create A `docs/verification/paws-services-pilot.md`；Reference A `paws-service.mjs`、`public/ai-service.js`、`test/submission-certainty.test.mjs`；P `packages/paws-agent/src/services/submission.test.ts`。

**Interfaces:** Consumes Task 3–4；Produces A7/A8/A9 的分层证据、回退演练和“允许准备上线”的判定。

- [ ] 用经过同意的旧平台历史验证“携带历史续聊”和“另开对话”；验证旧个人历史及已有直接 API/分享兼容。缺少现存兼容连接时记录不具备验收条件，不创建新的未纳管连接冒充旧连接。
- [ ] 验证断线前后、页面刷新、停止、执行器重启后读取原请求。活动请求不得换 ID、重建密文或改变绑定。
- [ ] 在隔离环境验证共享存储两种并发时序，以及旧客户端升级流程。运行 P `pnpm --filter @wangjs-jacky/paws-agent exec vitest run src/services/submission.test.ts` 和 A `node --test test/submission-certainty.test.mjs`，预期无失败。
- [ ] 在验收环境模拟离线、撤销和明确拒绝；上游额度不足优先使用已验证结构化夹具或自然出现的错误，不耗尽真实额度。记录哪项是模拟，不声称全部故障在上游实际发生。
- [ ] 演练将新对话默认恢复 legacy，已有 Paws 请求继续按原绑定读取/取消。不退回无法识别新绑定的旧代码，不删除新增表。
- [ ] 核对生产将使用的存储作用域：同一请求的所有实例共享原子存储。禁止以分散 SQLite 文件的多实例配置上线。
- [ ] 有代码修改时运行受影响回归；本任务完成后运行 A `npm test` 与 `npm run build`，保存结果及兼容测试跳过原因。
- [ ] 独立评审 A1–A12 汇总。A10 此时沿用已有第二应用证据，Task 6 对确切新包复核；Task 8 只固化试点经验，不作为此处的未来依赖。未完成项不能通过合成证据改名为完成。通过后提交记录。

**通过条件：**真实核心链路可用；故障测试的证据层级清楚；回退不重复执行；没有未处理的代码阻塞。

### Task 6: 固定确切发布产物与上线批次

**Files:** Modify P `docs/releases/shared-ai-services-candidate.json`、`docs/releases/shared-ai-services.md`；A `docs/verification/paws-services-rollout.md`；发布需要时更新两个消费者的版本/lockfile/vendor。Reference `.github/workflows/paws-agent-release-tag.yml`、`paws-agent-npm-publish.yml`、`web-production-deploy.yml`、`ota-preview.yml`、`ota-production.yml`。

**Interfaces:** Consumes Tasks 1–5；Produces 确切提交/版本/哈希/发布顺序、备份与排空步骤、客户端重载清单和回退触发条件。

- [ ] 重新读取 registry 和仓库发布规则，选择未占用的正式版本。不能把本地 0.3.0/0.1.0 当成已发布版本或覆盖旧版本。
- [ ] 从明确提交打包，两个消费者使用同一包字节。重新校验 tar 内容、安装结果、公开 exports、lock 完整性和应用构建。运行 `pnpm --dir packages/happy-server exec vitest run sources/app/aiServices/smokeAcceptance.spec.ts --maxWorkers=1`，预期实际路由与已安装包验收无失败，持续服务用例可按原约定跳过；只重跑因产物变化受影响的其他测试。
- [ ] 按发布机制准备 PR/CI 产物。先核对 PR 是否自动发布 preview；main 合并会影响哪些 Web/OTA，不在不了解副作用时推送或合并。
- [ ] 准备完整批次：兼容 Server/schema → worker → 管理/授权客户端 → 确切 SDK/组件 → 狗头军师。各步骤写明实际执行入口、验证结果和失败时停在哪一步。
- [ ] 登记生产存储类型、私有备份引用、恢复演练、活动请求与不确定请求、入口限制和旧客户端停止/重载安排。不能只写“可回滚”。
- [ ] 独立评审确切批次。在现有授权不足以执行外部变更时，把具体操作与影响范围一次提交用户确认；未获授权仍可完成所有本地准备。

**通过条件：**发布输入可复现、回退可执行、权限范围明确。准备完成不等于已发布。

### Task 7: 仅狗头军师上线及机主日常试用

**Files:** Update A `docs/verification/paws-services-pilot.md`、`docs/verification/paws-services-rollout.md`；P 候选清单与验收矩阵。

**Interfaces:** Consumes 已放行的 Task 6 批次；Produces 实际发布来源、狗头军师线上验收及机主反馈。其他网站保持原状。

- [ ] 按批准批次执行，逐项保存 commit、包哈希、迁移结果和运行链接。Paws Web 只走仓库规定的 main CI；不得从功能分支绕行发布。
- [ ] 停止接收新生成请求并排空已接收回合；不确定请求按原 ID 查询。确认备份后执行兼容迁移和组件更新。
- [ ] 核对 Server、worker、管理端及包就绪后，才切换狗头军师默认服务。确认新对话经 Paws 执行，应用没有另启默认 Codex。
- [ ] 复核默认平台提问、我的 Paws、模型设置、图片、停止、旧历史恢复和本轮执行详情。确认实际运行版本与批准批次相同。
- [ ] 由机主完成一次完整日常咨询并反馈。没有人为增加人数、调用次数或观察天数门槛。机主尚未试用时写“技术验收完成，日常使用待确认”。
- [ ] 出现身份不符、越权、重复执行或历史损坏时停止新请求，按演练恢复新对话默认；保留已有 Paws 请求的恢复路径。
- [ ] 独立复核发布记录和用户可见结果。机主确认后记录首接通过，才允许讨论其他站点迁移。

**通过条件：**狗头军师真实可用且机主确认；线上来源可核对。未触发或失败的 OTA 分别记录，不宣称已发布。

### Task 8: 固化公共接入材料

**Files:** Create P `docs/ai-services-integration.md`；Modify `examples/ai-service-smoke/README.md`，有确切试点发现时才修改示例业务层。

**Interfaces:** Consumes 首接真实经验和已发布包；Produces 应用登记表、持久化/归属校验要求、公共面板挂载与配置说明、版本升级及验收清单。

- [ ] 写清应用必须提供的 appId、受信 origin、业务提示词、宿主登录/会话归属和持久化存储。使用包内现有公开签名，不创造另一套 facade。
- [ ] 列明可以直接复用的 SDK、控制器、面板、状态和管理页面；业务提示词、数据存储及咨询/学习界面仍由应用负责。
- [ ] 将现有最小示例更新到试点同一确切包。使用者只需应用登记和业务输入，不复制扫码、加密、模型选择或恢复逻辑。
- [ ] 在独立安装目录按说明构建示例，验证公开 exports 和一个最小回合。合成执行只证明安装/集成，不能替代 Task 7 真实证据。
- [ ] 独立评审说明能否由未参与开发者执行，提交材料。

**通过条件：**第二个应用能按文档接入同一方案；没有新增一套授权或硬编码模型。

### Task 9: 核对其他网站并形成逐站推广计划

**Files:** Create P `docs/verification/shared-ai-pilot/adoption-map.md`。本任务不修改其他应用代码或部署配置。

**Interfaces:** Consumes Task 8；Produces 每个站点的实际仓库、部署、设备、账号引用、调用方式、是否用 SDK、权限类型和下一批范围。

- [ ] 核对 `study.paws.rodeo`、`academy.paws.rodeo`、`mac-ops.paws.rodeo` 和 MISS Studio。域名与产品名须以实际项目确认，不能仅凭截图猜测。
- [ ] 每站记录当前默认路径、个人路径、账号来源和额度观察来源。已安装 SDK 不等于已经纳入中央账号管理，二者分开记录。
- [ ] 先为纯问答站点制定独立接入任务，沿用公共 SDK/面板，只增加应用登记和业务适配。
- [ ] MISS 采集和 Mac Ops 另列工具能力设计。只复用连接、配置与管理，不将它们接到无工具聊天执行器后就声称迁移完成。
- [ ] 给出每站回退方式和验收范围。每批只迁移一个应用，得到该批授权后执行；不把本计划认可视为自动推广所有网站。
- [ ] 独立评审映射的证据来源，提交下一批具体计划。

**通过条件：**后续站点范围明确、无猜测映射、有单站验收和回退方案。此任务只完成推广计划。

## 完成口径与自审

- 第一轮本地实现不重做；本计划补足真实验收与交付。
- 原设计 1–11 节由既有实现加 Tasks 2–5 验证；第 12 节由 Tasks 5/7 验证；第 13 节由 Tasks 3–9 覆盖；第 14 节由 Tasks 1/2/6/7 覆盖。
- A1/A2/A3/A4/A5 → Task 3；A6/A11/A12 → Task 4；A7/A8/A9 → Task 5；A10 → 已有基线和 Task 6 的确切包复核，Task 8 固化材料。Task 7 复核线上版本和机主反馈。
- 五项 Review Focus 分别落入 Tasks 2、3、4、5、5/7。
- 不新增业务限额、计费、SSO、自动跨账号回退、完整聊天 UI 或 Tauri。已有资源保护保留。
- 环境准备、真实验收、候选发布、线上使用四种状态分开；未完成条件不被整体“通过”覆盖。
- Stage 1 已执行 Task 1 与 Task 2 的独立环境准备。Task 2 保留明确阻塞；没有生产发布或真实模型回合。后续仍采用逐任务实施和独立评审。
