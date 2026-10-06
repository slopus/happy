# Paws 公共 AI 服务验收环境

日期：2026-10-06。任务：Stage 1 / Task 2。状态：环境准备已执行，真实执行器条件未满足。Task 2 尚未通过。

本次建立独立 Server、PGlite 数据库和私有 HTTPS 入口。管理 Web 来自当前源码的新构建。没有登录真实账号，没有启动验收 worker，没有执行原生模型回合。狗头军师生产默认值没有变化。

## 私有清单与隔离范围

私有记录引用为 `PILOT-20261006`。执行者从受限运维存储解析其 `manifest.json`。实际 HTTPS 域名、绝对路径、进程号和配置留在该清单。本文不保存凭据或授权 receipt。

| 项目 | 已验证状态 |
| --- | --- |
| Server | `happy-server-self-host@1.1.11`；Node `24.20.0`；通过 `node --import tsx sources/standalone.ts serve` 运行当前源码 |
| 产品代码 | `00a426aaeb59cb70a12efd627646150fe141bea4`；准备时 HEAD 为 `63adf5baa837b14bc765211379d27e098312dec9`，其后没有产品代码改动 |
| 来源约束 | 私有清单保存 Server、Prisma、CLI、wire、App 的 Git tree。启动入口检查 tree 和未提交产品差异；来源变化时停止启动 |
| 数据库 | 独立 PGlite 目录；没有继承生产 `DATABASE_URL`、Redis、S3 或 GitHub 配置 |
| 本机监听 | 明确绑定 `127.0.0.1:3315`。不使用可能终止 3005 端口进程的 `server dev` |
| HTTPS | Tailscale Serve 的独立 8444 监听，仅在 Tailnet 内可用，转发到隔离 Server；没有配置 Funnel |
| 管理 Web | 当前 App 源码重新导出；API 编译值和 HTML 注入值均为私有验收 origin |
| 执行器配置 | 独立 `HAPPY_HOME_DIR`、`HAPPY_SERVER_URL`、`HAPPY_WEBAPP_URL` 与 `CODEX_HOME` 已准备；未登记账号或机器 |
| 文件权限 | 私有目录为 0700；清单、配置、日志和备份为 0600；私有控制入口为 0700 |

Server 环境采用明确的变量清单。主密钥为新生成的独立值。文件和预览存储都在验收数据目录。配置中 `PUBLIC_URL` 也指向验收 origin。没有读取或复制生产认证 JSON。

Server 使用当前源码，不依赖旧 `dist/standalone.mjs` 的未知来源。CLI 候选源码版本为 `1.3.18`；目前只准备官方登录入口。没有已验证的 Server/worker/管理客户端完整组合。

## 迁移、备份与恢复

执行 `node --import tsx sources/standalone.ts migrate`，退出码为 0。共应用 53 项迁移。包括全部 50 项前置迁移，以及基线记录的三项新增迁移。私有 `migration-checksums.json` 保存按名称排序的全部路径及 SHA-256。没有运行开发迁移、reset 或生产 SQL。

选择 PGlite 是因为现有 standalone 入口在该独立目录中成功执行全部迁移，并成功启动。这个结果不证明生产 PostgreSQL 的迁移兼容性。生产数据库未检查或迁移。

在迁移进程退出且 Server 尚未打开数据库时，创建冷备份。其后配置验收应用，再创建第二份冷备份。

| 备份引用 | 内容 | SHA-256 |
| --- | --- | --- |
| `schema-53` | 完成 53 项迁移的独立数据目录 | `a021f9575c14d5fa2aa32636c463f1a8e7bd97c6f4e7083821b3695898ee0815` |
| `configured-53` | 同一数据库，加验收应用的明确 origin | `d0fed223a49e00fa0fb14d4fe5ff192f6844bbd6a7009506c13bea98321cce2f` |

第一份备份恢复到另一个验收目录。恢复库新增 `pilot_restore_canary` 表。运行库没有该表。两个库的 53 项迁移名称相同。

第二份备份另行恢复到第三个目录。通过真实 registry 和 Prisma/PGlite 适配器核对：正确验收 origin 可读，错误 origin 返回 `permission-denied`。chat/images、业务提示词和 53 项迁移均存在。两个恢复检查的退出码均为 0。

恢复步骤：

1. 从私有清单读取备份引用和对应 SHA-256。
2. 校验备份字节。保留原独立主密钥配置；不要生成替代值。
3. 选择受限运维目录中的新恢复目录。确认该目录不存在。不要指向运行库或生产目录。
4. 解包数据到新目录。以明确 `DB_PROVIDER=pglite` 和新 `PGLITE_DIR` 打开恢复库。
5. 比较全部迁移名称和应用策略。使用恢复库检查 origin、能力和提示词。
6. 保留运行库。需要后续切换恢复库时，先另行核对活动请求、来源和授权范围。

这些备份目前没有真实账号数据。官方登录后，需要在验收 Server 停止且数据落盘后另建恢复点。不要在持久目录正在被 PGlite 使用时复制它。

## HTTPS 与管理客户端

Serve 启用前重新读取配置，确认没有已有路由。保存空配置和目标端口未占用证据。只增加独立 8444 监听。没有修改 Tailscale wrapper、生产 ingress、全局代理、证书信任或 DNS 设置。

首次普通 DNS 请求超时。直接 Self Tailscale IPv4 的 `--resolve` 请求返回 HTTP 200、`ssl_verify_result=0`。该检查保留 HTTPS 主机名，没有关闭证书校验。之后普通 DNS 的 IPv4 请求也返回 HTTP 200、`ssl_verify_result=0`；DNS 地址与 Tailscale Self 地址相同。普通 IPv6 路由未验证。

新 Web export 共 1,014 个文件，60,754,757 字节。文件清单树 SHA-256 为 `24abbf7d798cd5a139406ffe4de4c94fd6df0e5e62794c901fb51e7cdcf786b6`。算法为：按路径排序，记录每个文件的相对路径、字节数和 SHA-256，对无空白 JSON 数组计算 SHA-256。清单留在私有记录。

导出使用 `EXPO_NO_DOTENV=1` 和明确的验收 API。第一次导出受现有 Watchman 查询阻塞；仅停止本次导出进程。第二次使用项目已有 `HAPPY_E2E_DISABLE_WATCHMAN=1`，退出码为 0。没有重启或清理全局 Watchman。没有上传 Web 或 OTA。

加入新静态目录后，只停止并重新启动本次隔离 Server。源码冷启动约需 50 秒；期间发生一次 HTTP 502，随后就绪。首页、`/auth` 和 `/ai-services` 均返回 HTTP 200，HTML 的 `window.__HAPPY_CONFIG__.serverUrl` 均等于唯一验收 origin。普通新浏览器存储下，该值优先于编译默认值。已有账号或自定义 URL 的存储可能有更高优先级，登录前必须检查实际目标。

| 已执行检查 | 结果与边界 |
| --- | --- |
| `/v1/ai-services/protocol` | HTTP 200；`ai-services/1`。这是就绪检查，不是模型执行证明 |
| 匿名 `/v1/ai-services`、`/v1/ai-services/workers` | HTTP 401 |
| 匿名 `/v1/apps/services` | HTTP 403 |
| `/v1/updates/` Engine.IO 握手 | HTTP 200，收到 open frame；仅证明传输入口，不证明已认证 worker 在线 |
| 手机可达性 | 未验证。需要真机连接同一 Tailnet，并打开私有 HTTPS 入口 |

所有上述命令行 HTTPS 请求使用正常证书信任和 `--noproxy '*'`。没有使用 `--insecure` 或 `allowHttp`。

根执行者另用全新 Ego 任务空间打开同一普通 HTTPS URL。浏览器返回 `net::ERR_CONNECTION_CLOSED`。只核对了错误状态，没有成功页面截图。命令行 IPv4 成功不能证明浏览器路径成功。浏览器 HTTPS 入口仍未通过；原生手机也未验证。没有通过修改浏览器或系统代理绕过该错误。

同一 Ego 空间随后只读打开本机 HTTP 页面。页面显示 Paws 手机登录和创建账号入口。顶部显示验收 HTTPS 目标；`window.__HAPPY_CONFIG__.serverUrl` 与私有清单完全一致。没有点击登录、创建账号或提交凭据。截图引用为 `paws-pilot-stage1-5cb40a2e-9783-441f-9506-93ac5a4a574d`。该结果只证明匿名本机页面渲染和配置，不证明浏览器 HTTPS 或真实授权链路。

## 应用、账号与执行器条件

只在验收库修改 `relationship-advisor` 的 origin 为唯一验收 origin。保留既有业务提示词 `relationship-advisor@1` 和 chat/images。生产允许来源没有扩大。验收域名目前提供管理 Web，不代表狗头军师消费者已部署。

验收库的 Account、Machine、AppChatWorker 和 AIServiceAuthorization 数量均为 0。没有创建合成所有者。没有签发平台授权。真实服务、精确账号、授权期限和覆盖权限需要在所有者正规登录后配置。当前匿名拒绝和 registry 检查不能替代真实授权范围验收。

所有者入口在私有 `bin/pilot-control.py`：

1. 先解决并验证浏览器访问私有 HTTPS 的条件。再在全新存储的浏览器打开私有 `serverOrigin`。核对目标后，通过 Paws 的正式流程建立验收账号。
2. 在交互终端执行 `paws-login`。该入口使用源码 CLI、独立 Paws home 和明确验收 Server/Web。不要加 `--force`。
3. 执行 `codex-login`。该入口使用已安装的官方 Codex 二进制和全新 `CODEX_HOME`。所有者完成官方登录，不提供密码或原始 token 给 Agent。
4. 执行 `codex-upload`。所有者核对显示的 Paws 指纹和目标 origin，再确认官方上传。不要从机器默认目录复制认证 JSON。第二个账号需要另一独立 home 和同样的正规流程。
5. 账号登记后核对中央账号引用与状态，再准备精确执行器和受限 platform-grant。私有 receipt 不能下发到浏览器。

worker 启动仍被阻止。当前 `sharedServiceWorker.ts` 使用 `homedir()` 为 Claude 构造环境，并在 announce 前读取本机 Claude 身份。`HAPPY_HOME_DIR` 或外层 `CLAUDE_CONFIG_DIR` 不能证明此路径隔离。没有启动 worker 来读取机器默认身份。需要在后续批准范围内提供可核对的独立原生身份范围，再完成官方 Claude 登录和 worker 登记。

## 启停与生产不变检查

从私有记录解析 `PILOT_HOME` 后，执行 `python3 "$PILOT_HOME/bin/pilot-control.py" start` 或 `stop`。入口检查进程归属和端口。不得改用裸 daemon 启动、生产 launcher 或 `server dev`。

HTTPS 撤销只使用已安装 Tailscale App CLI 的 `serve --https=8444 off`。撤销前确认 8444 仍是本任务监听。不要执行 `serve reset`。撤销后读取 Serve 状态；其他任务后加的路由应保留。重新启用只使用本任务私有记录中的准确 target。

已实际演练该退出路径：核对当前路由等于本任务保存值；关闭 8444 后，状态为空；重新启用后，路由与保存值完全相同。两个命令的退出码均为 0。随后普通 DNS IPv4 的协议请求返回 HTTP 200、`ssl_verify_result=0`。没有撤销或重建其他监听。

生产前后清单显示：生产 Server 环境文件和 launcher 的 SHA-256 相同，3305 和 5433 监听 PID 相同，原 daemon PID 仍存活。没有改写生产配置，没有停止或重启生产进程。这个证据不等于生产数据库逐行比较或全部生产业务回归。

一次隔离 Server 停止时，后台 Session 查询记录了 PGlite/Prisma 的 `Response from the Engine was empty`。8 个关闭处理器随后在 429 毫秒内结束。第二次启动和上述接口检查通过。保留该关闭时序观察，不宣称全部运行日志无错误。

## 未完成项

- 普通浏览器访问私有 HTTPS 仍失败。先验证受信管理入口，再开始所有者登录。
- 所有者建立验收 Paws 身份，并完成两个精确 Codex 身份的官方登录与上传。
- 证明 Claude 原生身份独立，完成官方登录，登记并启动真实 worker。
- 读取真实能力目录，签发限定应用、服务、目标、chat/images 和期限的 platform-grant。
- 在真实原生手机验证 Tailnet、HTTPS 和验收客户端目标。
- 独立评审隔离及恢复证据。

这些条件满足前，Task 2 保持未通过。Task 3–9 不在本次执行范围内。
