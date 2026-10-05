# 公共 AI 服务发布准备

日期：2026-10-06。状态：已准备本地候选记录。公共包未发布。生产未部署。狗头军师保持 `legacy`。最终分支评审尚未完成。

T0–T10 已通过各自的本地实施评审。[验收矩阵](../verification/shared-ai-services.md)仍有真实能力缺口。A1、A3、A4、A5、A6、A9 未完成真实提供方、精确账号、个人授权、原生手机或旧链路验收。因此不能声明全部技术验收通过，不能开启生产试点。

## 候选版本与来源

[候选清单](shared-ai-services-candidate.json)保存代码提交、查询时间、包内文件清单、文件大小和 SHA-256。它不是部署记录。

| 项目 | 已准备内容 | 发布前剩余条件 |
| --- | --- | --- |
| Paws | 代码 `a7557dc60f2c1d40f27a1ab00732e08c770cf1e8` | 最终评审与真实验收 |
| 狗头军师 | 代码 `1d5881100cacb4080aa682a6adb30887747872e7` | 真实验收、发布授权与重建 |
| SDK | 本地 `@wangjs-jacky/paws-agent@0.3.0`，45 个文件 | 按发布时 registry 与仓库规则确定版本 |
| 公共面板 | 本地 `@wangjs-jacky/paws-connect-ui@0.1.0`，8 个文件 | 确认发布权限和具体发布流程 |

SDK SHA-256：`d3b126c9da01aeb0eef919fba47fc9a2cb561e035864b99d345104751e735f5a`。

面板 SHA-256：`336608ab2da2c24fca13543df030421de932d3ae18a2b42adba9cde67b3954ce`。

包分别对应 SDK 最后修改提交 `a7557dc60f2c1d40f27a1ab00732e08c770cf1e8` 和面板最后修改提交 `8d3b034ca4ac9f3a410f0cad01bc2273da64fc0b`。这是本地任务记录的来源关联。包内没有 `gitHead`，没有发布 tag，不能把这些提交当作已发布来源证明。

2026-10-06 的公开 registry 查询返回 SDK `latest=0.2.0`，版本列表没有 `0.3.0`。面板查询返回 404。404 不证明有发布权限。再次查询失败时，应停止版本选择，不能把网络错误当作版本不存在。CLI 的公开 latest 为 `1.3.18`；本分支没有为执行器选择新的发布版本。

两个消费者使用相同字节。狗头军师保存于 `vendor/paws/`。第二应用保存于 `examples/ai-service-smoke/vendor/`。两个 lockfile 都固定各自仓库内的文件。删除临时评审目录不会删除这些包或运行依赖。

本次保留已验收版本和包哈希。正式发布前需要从同一明确发布提交重新打包、验收和更新两个消费者。不能仅改版本后复用旧包或旧浏览器构建。

## 包发布清单

以下步骤需要后续发布授权。本次没有执行远端提交、合并、tag、workflow dispatch 或 npm 写入。

1. 完成真实能力验收和最终分支评审。重新查询 registry、已有 tag 与发布策略。
2. SDK 使用 `release/paws-agent-v<version>` 分支。按 `packages/paws-agent/scripts/prepare-release.mjs` 更新版本与变更记录。以 `chore(agent): release paws-agent v<version>` 为 release PR 标题。
3. 通过 PR 合入 main。现有 `paws-agent-release-tag.yml` 生成不可变 tag，并触发准备流程。合并也会触发 Web 和可能的 OTA 工作流；合并前必须确认部署顺序和授权范围。
4. `paws-agent-npm-publish.yml` 构建并打包 tag 指向的提交。空 `ego_verified_sha256` 只准备产物。下载该产物，运行 `verify-pack.mjs --prepare-browser`，用 Ego 验收输出的浏览器夹具。记录文件清单和 SHA-256。
5. 在后续授权下以同一 tag 和验收哈希执行发布。workflow 校验重新生成的包哈希。若不相同，停止并验收实际候选包。不能填写本清单中的旧哈希来批准新包。
6. 面板目前没有专用发布工作流。发布前必须审阅其版本、不可变提交、pack 文件清单、SDK peer 兼容范围和操作者权限。构建后只打包一次，验收该确切包，再发布该包。不能声称已存在面板自动发布入口。
7. 核对 registry 上的确切版本、完整性和压缩包哈希。用隔离消费者安装、构建并检查公开 exports。SDK 旧授权、历史和新服务入口都需要复核。包版本不能覆盖或复用。
8. 两个消费者锁定同一确切发布版本和 lockfile 完整性。若继续保存 tarball，也必须保存同一发布包字节。重建两个消费者，重跑受影响的回合恢复、来源隔离和面板检查。登记新哈希及其相对本地候选的变化。
9. 保存 npm 来源、tag、commit、运行链接、tarball、哈希和验收范围。SDK Actions evidence 保留 90 天；在到期前保存到持久证据位置。CLI/SDK 不创建 GitHub Release；Android APK 按既有规则处理。

## 兼容与部署顺序

| 组合 | 行为与限制 |
| --- | --- |
| 旧 Server、旧 worker、旧客户端 | 保持既有服务。新 `ai-services/1` 不可用。 |
| 新 Server/schema、旧 worker | 旧协议继续可用。不能把旧 worker 报为新服务就绪。 |
| 新 worker、旧授权 | 旧授权范围保持原样。新增 Claude 或新服务权限需要明确批准。 |
| 新 Server、worker、管理界面 | 完成 live probe、精确凭据和授权检查后才允许试点。 |
| 狗头军师默认 `legacy` | 新对话走 legacy。已有 Paws 绑定继续读、取消和执行原绑定。保留私有配置。 |
| 旧个人历史与直接 API | 保留旧浏览器协议及只读分享入口。直接 API 只兼容已有连接。真实链路仍待验收。 |

旧 app-chat 协议 1–3 的实现保留；新的授权记录使用协议 4，服务协议为 `ai-services/1`。协议数字相同不等于具备 live probe 或精确账号凭据。不能用机器默认账号证明中央账号选择。

按 Server/schema → worker → Paws 管理与授权界面 → 狗头军师消费者执行。新应用授权和消费者入口应保持未启用，直到受信环境就绪。此仓库没有本次新增的全局一键发布开关。上线人员必须先审阅入口阻断方案。若使用 ingress 隔离，不得阻断旧路由或已有 Paws 绑定的读/取消路径。

Server 有三项追加迁移，按顺序执行：`20261005000000_ai_services`、`20261005010000_ai_service_execution`、`20261006000000_ai_service_conversation_creation`。第三项新增应用会话 ID、创建输入及唯一键，支持原请求恢复。它们新增服务、修订、授权、绑定、能力、probe、业务提示词及执行字段。修订、绑定和提示词不可原地修改。迁移中的应用登记只允许 `https://advisor.paws.rodeo`，权限为 chat/images。它不会登记其他站点。

生产数据库尚未检查或迁移。先核对实际存储类型、已应用迁移、独立备份和恢复演练。PostgreSQL 迁移须由授权操作者执行；不能运行开发用 `migrate dev` 或 reset。PGlite 须核对实际持久目录与既有 standalone migration 入口。保留前置迁移，不只执行三段新 SQL。回退代码时保留新增表、字段和已写数据。

## 受信环境的门槛

- 提供 SDK 可接受的 HTTPS API origin。现有公共 HTTP-IP daemon 配置不能直接用于新 transport。验证 TLS 信任、API 路由、Origin 和应用反向代理。禁止 `allowHttp` 绕过。
- 按精确中央账号签发、兑换和刷新凭据。两个 Codex 账号分别完成最小回合。刷新仍归属同一账号。不要复制私有认证 JSON 或更改机器默认登录。
- 提供已登录 Claude 身份，完成新协议回合。记录上游实际模型/推理；无法确认时保留未知。不能用合成探针替代。
- 由服务所有者明确发放狗头军师 `platform-grant`。scope 固定应用、服务、chat/images、账号目标、覆盖权限和期限。验证不同应用、错误 Origin 和终端权限被拒绝。平台 receipt 只保存在应用私有文件。
- 个人密钥由个人端持有。完成真实桌面跳转、原生手机确认、记住连接、退出和撤销。不得把个人解密密钥交给应用后端。
- 真机安装包、channel 和 runtime 以仓库机器可读配置为准。执行 `pnpm --dir packages/happy-app exec vitest run sources/utils/otaRuntimeConfig.test.ts` 后，再按既有授权流程发布。Web 成功不代表原生手机成功。

## 构建、备份与回退记录

本地复跑命令在[验收记录](../verification/shared-ai-services.md)。Server runtime 构建需要 Bun 1.4.2 位于 PATH。安装依赖和构建 wire 后，运行 `pnpm --dir packages/happy-server run build`。不要把临时工具目录写进发布依赖。

最终修复后的本地 Web export 已通过，未上传。输出共有 1,014 个文件，60,754,700 字节。主 bundle SHA-256 为 `ddf34a462db923cdbe1d9b5d1a93a4791bc7fadea13f59d6413188b9b0da45bd`。本次重新构建包含 checkbox 语义修正的管理界面。候选清单同时保留 T11 导出，但明确标为历史证据。Watchman 超时后，Metro 用 Node crawler 完成构建；既有包 exports 与环境警告仍存在。本地构建不证明真实提供方或原生手机可用。

生产 Web 仍只通过 main 的 `web-production-deploy.yml` 发布到 `https://47.115.228.20:8443`。按 `scripts/deploy-web.sh` 校验 OSS 哈希资源、原子切换和发布 commit。不要复用本地验收构建上线。

部署前填写私有运维记录：当前 Server 镜像或 npm 包及 digest、worker 包/tag/commit、Web release 路径、OTA stamp/channel/runtime、狗头军师 release 路径、应用 SQLite/认证 PostgreSQL/Paws 存储的备份位置与时间、恢复演练结果、活动回合计数、部署人和回退决定人。生产旧版本尚未读取，因此这些值仍待填写。不得把候选提交当作当前线上版本。

停止接收新生成请求后排空旧回合。记录 accepted/running 与不确定提交，按原 requestId 查回合；取消后读取终态。没有 drain 自动化，也没有本次实测的生产排空。不能因重启、超时或发布进程退出而重放请求。

出现错误身份、越权、凭据泄露、重复执行或历史损坏时停止试点。授权/凭据问题先撤销受影响授权，并说明不可用范围。常规回退将狗头军师新对话默认恢复 `legacy`。已有 Paws 绑定仍依赖新兼容 Server、worker 和应用读/取消路径，不能退到不认识这些绑定的旧程序。详细步骤见狗头军师 `docs/verification/paws-services-rollout.md`。

## 试点完成条件

完成技术门槛后，机主还需完成一次日常咨询。检查回复、旧历史恢复、图片、执行详情和个人服务。真实旧个人授权、直接 API 和分享也需回归。此时才可记录“技术验收通过，日常使用待确认”或填写实际机主反馈。目前两者均未完成。

只试点狗头军师。知学、缠论需另列批次。MISS 与 Mac Ops 需要独立工具能力设计。本清单不授权迁移其他应用。

迁移清单核对：在 Paws worktree 运行 `node scripts/verify-shared-ai-migrations.mjs`。它对比评审基线以来新增的全部迁移，并逐项校验 SHA-256。此命令不会连接数据库。
