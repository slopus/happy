# 公共 AI 服务验收

日期：2026-10-06。阶段：T10。结论：本地合成验收通过。真实提供方和原生手机验收未完成。不能进入“全部验收通过”或推广阶段。

本次没有发布包、部署服务、切换登录账号或修改生产设置。以下“通过”只适用于表中明确列出的范围。合成执行器不会调用上游模型。

## 版本与安装包

- Paws 基线：`da8607f858901463d67c6cce9cfc83fc0f53c4d7`。
- T10 代码：`eb051402`。包含第二应用、实际路由测试和执行器在线期限修复。
- 夹具修正：`e4779dea`。持续验收期间等待真实 worker announce 完成。
- 狗头军师代码：`e7434b6e53dc4242d6c0bfb36f2b45603fde239a`。
- SDK：`@wangjs-jacky/paws-agent@0.3.0`。UI：`@wangjs-jacky/paws-connect-ui@0.1.0`。协议：`ai-services/1`。

两个应用使用完全相同的压缩包。狗头军师保存于 `vendor/paws/`。第二应用保存于 `examples/ai-service-smoke/vendor/`。它们均由各自的 `package.json` 和 `package-lock.json` 固定。没有运行时源码导入或临时评审目录依赖。

| 包 | SHA-256 |
| --- | --- |
| `wangjs-jacky-paws-agent-0.3.0.tgz` | `d3b126c9da01aeb0eef919fba47fc9a2cb561e035864b99d345104751e735f5a` |
| `wangjs-jacky-paws-connect-ui-0.1.0.tgz` | `336608ab2da2c24fca13543df030421de932d3ae18a2b42adba9cde67b3954ce` |

## A1–A12

| Case | 状态 | 已有证据和剩余条件 |
| --- | --- | --- |
| A1 默认服务 | 未执行 | 实际路由和已安装 SDK 完成合成回合。狗头军师实际界面可提问。尚无经新协议完成的真实提供方回合。 |
| A2 中央配置 | 通过（本地合成） | 服务从修订 1 改为 2。新对话使用新模型和推理设置。旧对话仍返回原绑定。未变更生产默认值。 |
| A3 多账号 | 未执行 | 盘点有两个 Codex 账号，但盘点不是执行证据。隔离服务没有连接真实中央账号的精确凭据签发、兑换和刷新回写链。 |
| A4 多引擎 | 未执行 | 新协议真实 Codex 回合未执行。2026-10-06 Claude 原生登录检查为 `loggedIn=false`、`authMethod=none`。 |
| A5 推理强度 | 未执行 | 本地实际路由接受支持值，拒绝不支持值。合成回合实际模型和推理均保留 `null`。仍缺真实回合的上游回报。 |
| A6 个人连接 | 未执行 | 已验证合成授权界面的明确范围选择。未完成真实桌面跳转、原生手机扫码确认、记住连接与撤销的完整链路。手机网页不替代原生确认。 |
| A7 断线与取消 | 通过（本地合成） | 区分接受前和接受后的丢包。已安装 SDK 恢复同一请求。每个已执行回合的执行计数为 1，重复执行数为 0。取消和租约过期不重放。狗头军师刷新恢复有实际浏览器证据。 |
| A8 故障边界 | 通过（本地合成） | 离线、账号失效、额度不足和撤销均失败关闭。绑定和付费来源不变。无自动账号、引擎或平台回退。额度错误由合成执行器注入。 |
| A9 历史迁移 | 未执行 | 狗头军师合成旧历史可选择携带或另开。实际 UI 和回归覆盖来源隔离。真实旧个人授权、直接 API 执行及分享未完成本轮端到端验收。 |
| A10 可复用性 | 通过（本地合成） | 第二应用使用相同安装包。只提供应用登记、平台桥接授权、摘要输入和界面挂载。未复制模型选择、授权或加密实现。 |
| A11 交互 | 通过（合成网页） | T7/T9 已通过 Ego 的桌面与手机网页、焦点、浅深主题和相关错误操作检查。此状态不覆盖原生手机或真实个人配对。第二应用也通过下文列出的独立 Ego 检查。 |
| A12 授权范围 | 通过（本地合成） | 第二应用不能读狗头军师绑定或回合。平台凭据不能访问全账号路由。错误来源被拒绝。终端权限请求被拒绝。执行器工具禁用另有 T3 回归，尚无真实提供方确认。 |

真实验收的缺失条件是具体的：新协议尚未部署到拥有真实中央账号的受信服务与执行器；隔离夹具只有合成身份。现有机器默认账号接口不能证明精确账号选择。没有复制认证 JSON、改变默认账号或绕过刷新归属。完成受信的精确账号授权链后，才可按已批准计划分别执行两个 Codex 账号的最小回合。Claude 还需要可用登录身份。原生手机验收需要用户在可用设备上完成确认。

## 可重复的第二应用验收

先在 Paws checkout 安装工作区依赖并构建 wire。第二应用独立安装依赖，不从工作区包链接源码。

```sh
pnpm install --frozen-lockfile
pnpm --dir packages/happy-wire run build
cd examples/ai-service-smoke
shasum -a 256 vendor/*.tgz
npm ci --ignore-scripts --no-audit --no-fund
cd ../../packages/happy-server
pnpm exec vitest run sources/app/aiServices/smokeAcceptance.spec.ts --maxWorkers=1
```

最终结果：5 项通过，0 项失败，1 项跳过。跳过项只用于持续提供浏览器夹具，不是未通过的功能测试。测试初始化独立的内存 PGlite。实际应用路由、授权、绑定、请求幂等、密文和 SDK 均参与执行。只有能力目录与提供方输出是合成数据。测试通过真实 worker 路由领取回合、读取注册提示词和发布结果。执行器解开自己的机器信封后取得消息密钥。

浏览器入口：

```sh
# 在 packages/happy-server 中运行。
PAWS_SMOKE_SERVE=1 pnpm exec vitest run sources/app/aiServices/smokeAcceptance.spec.ts --maxWorkers=1
```

打开 `http://127.0.0.1:4193/`。只使用公开合成文本。发送后点击“同步原回合”读取结果。展开执行记录，检查绑定与 `actual`。在公共面板中修改高级设置，再点“新对话”。发送 `[slow]` 可检查取消。浏览器操作只使用 Ego。Ctrl+C 结束夹具。它不加载磁盘凭据，也不写生产库。

浏览器初次延迟检查发现夹具空闲后离线。原因是定时器没有等待惰性数据库调用。修正后每 10 秒等待真实 announce 路由完成。空闲 46 秒后，实际 workers 查询、新绑定和一个完整合成回合均通过。该修正没有改变产品 UI。

`server.mjs` 由测试 harness 注入临时配置后启动。直接运行它不会寻找生产认证。这个单用户演示仅使用内存服务存储，不声称重启进程后仍可恢复。生产应用应提供持久化存储和真实用户归属检查。服务端测试 harness 属于测试基础设施，不属于第二应用业务代码。

## 执行器在线期限修复

问题：一次健康回合可超过 45 秒。原来的心跳只延长 15 秒回合租约，未延长执行器的 `activeUntil`。服务因此可将仍在执行的机器报为离线。

RED：把 worker 在线期限设为已过期，保持有效回合租约，再发送合法心跳。旧代码仍返回 `activeUntil=0`，断言失败。错误 lease 不更新在线期限。

GREEN：合法心跳或结果提交在同一事务中续期 worker 45 秒。授权、当前 lease、回合期限及消息校验均先通过。无效或过期 lease 不续期。锁顺序为 Account → worker → 授权/服务 → turn，与 claim/probe 保持一致。没有通过 UI 隐藏离线状态。

```sh
# 在 packages/happy-server 中运行。
pnpm exec vitest run sources/app/aiServices/turns.spec.ts --maxWorkers=1
PAWS_TEST_POSTGRES_URL=postgresql://paws_test@127.0.0.1:49993/postgres \
  pnpm exec vitest run sources/app/aiServices/postgresConcurrency.spec.ts \
  -t 'renews heartbeat liveness' --maxWorkers=1
pnpm run typecheck
# 需要 Bun 1.4.2 可从 PATH 运行。
node scripts/build-runtime.cjs
```

结果：PGlite 回归 1 项通过。隔离 PostgreSQL 15 并发回归 1 项通过，其余 12 项未重跑。新检查用两个数据库连接制造真实锁等待：heartbeat 持有 worker 锁时，claim 等待该锁；放行后无死锁，也不重复领取；过期 lease 不能恢复在线状态。该 PG 测试需要预先配置本机专用 `paws_test` 集群。它仅接受 loopback 地址和指定测试用户，自建临时数据库并在结束时删除。不要指向生产库。

Server typecheck 通过。Bun 1.4.2 构建运行包通过（143 个模块）。首次构建因 PATH 缺少 Bun 失败；补充已安装工具路径后通过。没有重跑未受影响的旧 PostgreSQL 套件。

## 保留的网页证据摘要

以下 ID 是已提交给 Happy 的 capture receipt 名称，便于审计。此处保留动作和断言，不依赖临时评审报告存活。它们不代表真实上游执行。

| 范围 | 已验证动作 | Receipt 后缀 |
| --- | --- | --- |
| Paws 合成授权 | 额外 Claude 默认不选；离线目标不可选；明确批准两个可用目标和 7 天；权限只有 chat | `zpJKdy` |
| Paws 桌面授权 | 新授权只包含当前默认目标 | `ECVcBj` |
| 狗头军师图片拒绝 | 纯文本模型拒绝首条图片消息，保留文本与附件 | `9BOONy` |
| 狗头军师接受后丢包 | 首条图片回合恢复原请求，清除草稿，只有一对消息 | `A0pP6J` |
| 狗头军师接受前丢包 | 拦截 POST 后刷新；恢复时只重发原 ID 一次，新增一对消息 | `13jhyR` |
| 狗头军师迟到附件 | 切换来源后到达的 FileReader 回调不写入新来源 | `wxBTiV` |
| 狗头军师历史读取 | 读取期间禁用删除和输入；完成后恢复 | `9mUqSr` |
| 狗头军师退出 | 应用与 SDK session 材料清除；历史界面退出 | `U31BxX` |
| 第二应用桌面 | 原绑定保持原设置；新对话使用覆盖设置；实际值为 null；Escape 返回原按钮焦点 | `pzq6yl` |
| 第二应用手机网页 | 390×844 无横向溢出；慢回合从 running 停止为 cancelled | `rqKYyB` |

第二应用 Ego 检查由主控完成，使用同一浏览器空间和实际 `4193` 路由。桌面视口为 1365×900。目录包含 `synthetic-a` 和 `synthetic-b`。默认回合使用请求模型 `synthetic-b` 和 `high`，状态为 completed。实际模型与推理均为 `null`。把面板改为 `synthetic-a` 和 `low` 后，原绑定仍使用 `synthetic-b/high`。点击“新对话”后，新绑定使用 `synthetic-a/low`，回合完成。按 Escape 关闭高级设置后，焦点回到原按钮。

手机网页视口为 390×844，没有横向溢出。发送 `[slow]` 后读取到 running，再点击“停止原回合”，最终状态为 cancelled。两张截图已由主控目视核对，并通过绑定 receipt 报告给 Happy。它们只证明合成网页行为，不证明真实提供方或原生手机确认。验收结束时没有活动回合。

狗头军师保留明确的直接 API 兼容例外。没有增加业务配额、计费、SSO 或跨引擎自动映射。仍需完成表内未执行项，并由机主完成一次日常使用，才能决定试点推广。

## 最终评审修复验证（2026-10-06）

代码：Paws `a7557dc60f2c1d40f27a1ab00732e08c770cf1e8`；狗头军师 `1d5881100cacb4080aa682a6adb30887747872e7`。上述 T9/T10/T11 记录保留为历史证据。当前包与构建以发布候选清单为准。

- 明确拒绝携带原 requestId 和 `submission=not-submitted`。缺少标记、标记不匹配或已有待恢复提交时，SDK 保持 `uncertain`。不可用 `retryable=false` 推断未接受。浏览器不能在请求体中提供此结论。
- 本地 SDK 校验在写入 journal 前执行。图片合计和个人累计历史超限时，保留可编辑草稿。HTTP 未发出。已接受但响应丢失的请求保留原 ID、内容和密文。
- 平台已证明拒绝的记录保留为 failed。取消无需上游 turnId；删除和其他对话容量可恢复。拒绝的消息保留在本地历史，不进入后续提供方上下文。
- 并发重复 POST 返回终态时，SDK 读取并校验加密结果。回归断言同一答案、sequence=7 和一次执行。
- 原生错误只读取结构化字段。Codex 依据本机0.159.3生成的 TurnError.codexErrorInfo 和标准 JSON-RPC 错误码。Claude 依据 SDKAssistantMessage.error 枚举。未知错误不扫描诊断文字，统一为 execution-interrupted。probe 保留安全的协议与身份错误。
- SDK27项、CLI32项、Server13项、管理界面2项测试通过。已安装新SDK后的实际路由用例再跑5项通过。狗头军师全套94项通过、1项跳过；最后的 journal41项和 adapter20项通过。SDK、CLI、Server和消费者构建通过。浏览器复核由控制者单独记录。
- 三项迁移按评审基线完整核对。未连接或迁移生产数据库。

公共包仍未发布。真实提供方、原生手机、个人完整链路和完整旧链路验收仍为 NOT EXECUTED。生产与推广保持阻断。实际 model/reasoning 没有观察值时保持 null。

## 控制者最终 Ego 复核（2026-10-06）

控制者使用最终狗头军师 bundle 和本地合成夹具，在390×844视口完成以下检查。此修复执行者没有操作浏览器。

- 三张有效700×700 PNG，每张1,471,213字节，合计超限。草稿和三张附件可编辑，恢复按钮不出现，没有横向溢出。最终文案为“请求内容过多或格式不受支持。请减少图片或文字后重试。”SDK初始化前安装的 fetch 观察器显示 turn POST 计数保持1→1。移除图片后，原草稿可正常完成合成回合。
- `[reject-model]` 明确拒绝后，草稿可编辑。另开对话并发送成功，证明本地容量已释放。界面显示安全的模型错误文案。
- `[lose]` 接受后丢失响应，输入保持锁定。恢复后只有一个原 turn POST，一条匹配的用户消息和对应回答，没有重复执行。

已报告的 capture receipt 后缀为 `kkiFJb`、`A26DKm`、`vbjDfP`、`LUUBmS`。最初在SDK初始化后安装的 fetch 观察器未覆盖SDK保存的 fetch，不作为网络证据；最终的初始化前观察器取代该指标。真实个人授权、提供方与原生手机仍未执行。
