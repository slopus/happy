# Paws 公共 AI 服务试点基线

日期：2026-10-06。任务：Stage 1 / Task 1。观察时间：2026-10-06 14:45–14:48 UTC（北京时间 22:45–22:48）。

本任务固定本地候选与剩余验收项。包、锁文件、安装字节和三项迁移检查通过。真实能力验收仍未完成。本次没有重打包、安装依赖、发布、登录、切换账号或修改生产数据。

## 工作区与主线

| 项目 | 本次结果 |
| --- | --- |
| Paws 开发目录 | `happy--shared-ai-services`，分支 `feat/shared-ai-services` |
| Paws HEAD | `8e040a7683b90bde77ad3974391ba0f019d4ed53`（本报告提交前） |
| Paws 已验证产品代码 | `00a426aaeb59cb70a12efd627646150fe141bea4` |
| Paws 根目录 | `happy`；干净 `main`；HEAD 与本地 `origin/main` 都为 `f1fec57f212cf9ce8b4bd2788a3a955a3f93ea46` |
| Paws remote | `origin=https://github.com/wangjs-jacky/happy.git` |
| 远端当前 main | 未知。14:46 UTC 的只读 `git ls-remote` 在 25 秒后超时。本地缓存不能证明当前远端主线。网络恢复后重试同一查询，并记录时间和 SHA；本任务不 fetch。 |
| 狗头军师开发目录 | `relationship-advisor--paws-services`，分支 `feat/paws-services` |
| 狗头军师 HEAD | `21a2c583e03c80f44a030f05e70b769bc2d65277` |
| 狗头军师已验证产品代码 | `c66c820a2a26a9450abc212928590181b7c5d683` |
| 狗头军师根目录 | `relationship-advisor-service`；分支 `main`；HEAD 为 `826a893681f12c3df03e278e897546d58c95a351` |
| 狗头军师 remote/main 来源 | 两个工作区都未配置 remote；不存在 `origin/main`。远端主线未知。仓库维护者需提供权威远端或确认此仓库仅在本机维护，再执行只读主线查询。 |

两个候选产品提交都是当前 HEAD 的祖先。Paws 自产品提交以来只改了 49 个 `docs/` 文件。狗头军师只改了 2 个 `docs/` 文件。产品代码没有新增差异，因此本次不重跑完整套件。

Paws 开发目录原有 590 个未跟踪 Watchman 文件和一个未跟踪试点计划。狗头军师开发目录干净。本任务保留这些文件，只提交本基线。Paws 根目录未写入文件。

项目约定来自 Paws `AGENTS.md`、`CLAUDE.md`，以及狗头军师 `deploy/README.md` 和 `docs/verification/paws-services-rollout.md`。狗头军师工作区没有根级 `AGENTS.md` 或 `CLAUDE.md`。Paws Web 常规发布仍为 PR → main → CI。开发 HEAD 不是线上 SHA。

## 固定候选与安装字节

候选依据：[shared-ai-services-candidate.json](../../releases/shared-ai-services-candidate.json)。协议为 `ai-services/1`。状态为 `unpublished-local-candidate`。正式发布版本尚未选择。

| 包 | 版本 | 字节数 / 普通文件数 | SHA-256 |
| --- | --- | --- | --- |
| `@wangjs-jacky/paws-agent` | `0.3.0` | 192,311 / 43 | `184e901a14a7115b29ffd4f0707f768d2595d9daf9b6ae0047b81fa96ba10613` |
| `@wangjs-jacky/paws-connect-ui` | `0.1.0` | 17,102 / 8 | `336608ab2da2c24fca13543df030421de932d3ae18a2b42adba9cde67b3954ce` |

第二应用包位于 `examples/ai-service-smoke/vendor/`。狗头军师包位于 `vendor/paws/`。本次逐项检查了四个 tarball。两个消费者的归档字节相同。每个普通成员的 SHA-256 都匹配候选清单；每个普通成员都与对应 `node_modules` 安装文件逐字节相同。两份 `package.json` 和 `package-lock.json` 都指向本地 tarball；四项 lock integrity 都等于归档的 SHA-512。

SDK SHA-512 integrity：`sha512-VuZMsob1E+a1urYcUktZ2TzQUspRabStHLkcO8p779baqIMWqW0ZORMP4wTooWfmA6NHvZ5xKES32h6YLxi9Lg==`。

面板 SHA-512 integrity：`sha512-k1qSrn+9w8yn7rGHZrYY3XL0DDWnp5roCIx/hBSaHWi0AzQd08794L7fvqI9RmJjfjLT9jDUI0C7xY1osCBdlw==`。

SDK 来源变更提交为 `00a426aaeb59cb70a12efd627646150fe141bea4`。面板来源变更提交为 `8d3b034ca4ac9f3a410f0cad01bc2273da64fc0b`。归档没有 `gitHead`。来源关联依靠本地任务记录和候选清单，不能称为带 tag 的已发布产物。发布前需从最终发布提交重打包，并验收该确切包。

狗头军师三项本地构建资源仍匹配候选：

| 文件 | SHA-256 |
| --- | --- |
| `public/client.js` | `66b169ffb6819a56c7a18cc8e410eb737951700c6972addc7564cb3301892022` |
| `public/paws-sdk.js` | `cc96e9fc9704b6f3a18d5dd1e47dfa8b62b1b9c33d626620d8f91126b9ec5f2d` |
| `public/paws-panel.css` | `1631c71d14abc20ead7dca965277a11961291cc44ed35cb9e587133099f016a8` |

Registry 的最近保留观察为候选中的 `2026-10-05T20:48:56.913036+00:00`：SDK `latest=0.2.0`，面板 HTTP 404。本任务未重新查询 registry 元数据。正式发布前需重新查询版本和发布权限；404 不能证明发布权限。

## 三项迁移

本次执行 `node scripts/verify-shared-ai-migrations.mjs`，退出码为 0。输出：`Verified 3 ordered migrations against f1fec57f212cf9ce8b4bd2788a3a955a3f93ea46`。该命令不连接数据库。

| 顺序 / 路径（相对 `packages/happy-server/prisma/migrations/`） | SHA-256 |
| --- | --- |
| 1. `20261005000000_ai_services/migration.sql` | `b426a821fc0dad6524915bc7e5451b82ab035f248859b78a77b061f87ca864a3` |
| 2. `20261005010000_ai_service_execution/migration.sql` | `8902e820bdcf2d8c79ec81e59994f229fb3dffd425be5a80bae3386f42fce48d` |
| 3. `20261006000000_ai_service_conversation_creation/migration.sql` | `b90158a45b09eff6baa4c99ea88832901e84e604725a8e957e42a362ed33dc70` |

生产 schema、备份、排空和恢复均未检查。后续需由数据库操作者核对实际存储及迁移记录，再按授权准备备份和恢复演练。文件检查不能证明生产迁移已执行。

## 已有部署来源

这些是只读观察，不是本候选的部署结果。来源核对参考 happy-ops 的 Web、Server、execution 指引；各系统需分别核对。

| 目标 | 本次观察 / 缺少证据 / 获取动作 |
| --- | --- |
| Paws 正式 Web | 14:47 UTC 通过 CLI GET `https://47.115.228.20:8443/`，HTML 的 `paws-release-revision` 为 `f1fec57f212cf9ce8b4bd2788a3a955a3f93ea46`。curl 退出码 0。请求使用 `--insecure`，只证明返回了该标识，不证明 TLS 信任或新 API 可用。部署前需通过受信 TLS 复查，并核对对应 CI summary 与静态资源。 |
| Paws Server | 当前运行 SHA、镜像 digest 和 schema 未知。HTML revision 不能代替后端 SHA。下一步读取实际 runner/release manifest 或容器 image digest，并关联部署记录；仅输出版本字段。 |
| 本机 CLI | 14:47 UTC 的 PATH `paws` 解析到 `Deployments/paws-cli/releases/cross-account-f1fec57f-20261005/bin/happy.mjs`；该 release 的 package 版本为 `1.3.18`。目录名称不是可验证的提交证明。需读取 CLI release 的来源 manifest 或构建记录并检查产物哈希。 |
| daemon / 活动 worker | 本次未查询运行进程。正在运行的进程可能与 PATH CLI 不同。下一步安全读取 daemon 状态和启动记录中的版本、入口及已登记 worker 版本；不输出完整环境或凭据。 |
| 狗头军师 release | 14:47 UTC 的部署 `CURRENT` 为 `session-restore-20261005-f0dbfff`。对应 `release-manifest.json` 的 commit 为 `f0dbfffea628506479810c9422489f664a0e78c3`，15 个文件哈希全部匹配。此为部署目录证据。 |
| 狗头军师运行进程 / 公网 | 本次未把 CURRENT 与运行进程或公网资源关联。下一步安全核对 LaunchAgent 的 release 入口，并读取匿名版本或资源哈希。保持现有生产配置不变。 |
| 原生 App / OTA | 当前设备安装包、Update ID、channel、runtime 未知。设备操作者需在原生设备报告这些值，并按仓库 runtime 契约核对。网页视口不能代替原生证据。 |

## 现有依赖告警

14:46 UTC 执行狗头军师 `npm audit --json --registry=https://registry.npmjs.org`。退出码 1；结果为 2 个 high、0 个 critical。这里的“2”是受影响包条目数，不是两个独立根因。

| 包 | 锁定 / 已安装版本 | 影响路径 | 处理决定 |
| --- | --- | --- | --- |
| `nodemailer` | `8.0.11` | `relationship-advisor-service → supertokens-node → nodemailer`；间接依赖 | 保留已知债务。本任务不升级。需独立核对可利用路径及兼容修复，再单独提交和验证。 |
| `supertokens-node` | `24.0.3` | 应用直接认证依赖；high 来自 `nodemailer` | 与上述依赖链一并单独处理，不混入账号迁移。 |

当前 audit 返回 Nodemailer 的 8 项底层公告。其中 3 项为 high：原始消息读取文件/URL（[GHSA-p6gq-j5cr-w38f](https://github.com/advisories/GHSA-p6gq-j5cr-w38f)）、地址解析二次复杂度（[GHSA-2x7j-588g-ccc2](https://github.com/advisories/GHSA-2x7j-588g-ccc2)）、自由文本解析回溯（[GHSA-v53p-9fqp-m79j](https://github.com/advisories/GHSA-v53p-9fqp-m79j)）。其他 5 项为 moderate。此为 registry audit 的时点结果。

`auth.mjs:16` 当前禁用邮件发送，密码重置 API 也禁用。这是应用配置事实，不足以宣布公告不可利用。audit 建议把 `supertokens-node` 变为 `9.2.3`，并标记 SemVer major；不能将这个建议直接用作兼容修复。没有运行 `audit fix`，没有修改锁文件。

## A1–A12 待验收清单

状态抄自 [shared-ai-services.md](../shared-ai-services.md)。本任务没有新增模型或浏览器验收。

| 项目 | 当前状态 | 证据边界 / 待办 |
| --- | --- | --- |
| A1 默认服务 | 未执行 | 实际路由和已安装 SDK 完成合成回合；缺少新协议真实提供方回合。 |
| A2 中央配置 | 通过（本地合成） | 新对话使用修订 2；旧对话保留修订 1；未变更生产默认值。 |
| A3 多账号 | 未执行 | 已有两账号盘点；缺少精确中央凭据签发、兑换、执行和刷新回写链。 |
| A4 多引擎 | 未执行 | 新协议真实 Codex 未执行。2026-10-06 保留记录的 Claude 登录为 `loggedIn=false`、`authMethod=none`；本次未重新查询。 |
| A5 推理强度 | 未执行 | 合成路由校验支持值；实际模型与推理保持 `null`；缺少上游真实回报。 |
| A6 个人连接 | 未执行 | 合成授权范围已检查；缺少真实桌面跳转、原生扫码、记住连接和撤销完整链路。 |
| A7 断线与取消 | 通过（本地合成） | 原 ID 恢复；执行数为 1、重复数为 0；取消及租约过期不重放。 |
| A8 故障边界 | 通过（本地合成） | 离线、身份失效、额度和撤销失败关闭；不自动回退。额度来自合成执行器。 |
| A9 历史迁移 | 未执行 | 合成历史和来源隔离已检查；缺少真实旧个人授权、直接 API 和分享端到端验收。 |
| A10 可复用性 | 通过（本地合成） | 第二应用使用相同包，无模型选择、授权或加密实现副本。 |
| A11 交互 | 通过（合成网页） | 已有 Ego 桌面和手机网页证据；不覆盖原生或真实个人配对。 |
| A12 授权范围 | 通过（本地合成） | 跨应用和错误来源被拒绝；终端权限被拒绝；缺少真实提供方工具禁用确认。 |

最终并发修复后的独立评审见 [certainty-re-review.md](../shared-ai-service-review/certainty-re-review.md)。N1/N2 已关闭，结论限于共享原子存储契约。所有同一 binding/request 的提交者必须共享持久化原子命名空间；启用前需停止或重载旧候选客户端。旧 Ego 截图不证明新并发协议。保留的 SDK 43 项、最终 submission 17 项、狗头军师 101 通过/1 跳过和 packed route 5 通过/1 跳过是前轮证据，本次没有重跑或相加。

## 下一阶段条件

- Claude：用户需明确处理登录条件。之后先只读确认可用身份，再在隔离环境执行真实新协议回合。本任务不登录或替换身份。
- 原生设备：设备需连接可达且受信的测试 HTTPS origin，安装匹配 runtime 的原生包。用户在设备上执行真实扫码确认，并提供记住连接和撤销证据。
- 可信 API origin：需分别证明 API TLS 信任、路由、Origin 校验、授权 Web 和应用代理。HTTP-IP、`--insecure` HTML 结果和合成夹具不能满足该条件。
- 中央凭据链：隔离 worker 需使用精确批准的两个 Codex 身份。分别验证签发、兑换、执行、版本与刷新回写归属。不能复制全部生产凭据，不能用默认身份替代失败目标。
- 日常使用：真实技术门槛完成后，由机主完成一次日常咨询并记录反馈。当前状态仍为待执行。

基线检查通过不表示真实验收、发布或生产切换获准。未知项已列出具体获取动作。后续执行者需先完成对应条件，再更新同一清单。
