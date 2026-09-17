# AgentParty × Paws：源码核查与最小改造边界

日期：2026-09-16。状态：源码审计完成；未实现、未部署、未运行真实 Agent。

## 固定底座

- 仓库：<https://github.com/1gr14/agents-party>
- 审计提交：`af00afbd49b3235c2084cff9849ef12353073484`，包版本 `0.7.2`。这是明确固定的源码快照，不宣称最新版本。
- 已有只读副本：`/private/tmp/agents-party-audit.EYv32u/repo`。
- 许可：根目录 LICENSE 为 MIT，复用时保留相应声明。
- 不与 `leeguooooo/AgentParty` 或 `heshengtao/super-agent-party` 混淆。
- 不引入 LangGraph，不安装 OpenClaw。旧 LangGraph POC 不是本方案的底座。

## 用户范围

一次股票多周期会诊：Mock 行情，真实远端 Agent，支持文字和图片。
总时间线展示公开发言；点击 Agent 展开对应 Paws 会话的执行记录。
运行使用用户远端机器已有的编码 Agent，执行资源留在远端。
本轮不扩展定时任务、长期记忆、真实行情或交易操作。

## 核实的复用点

| 已有能力 | 源码位置 | 说明 |
| --- | --- | --- |
| 消息总线 | `src/client/connection.ts:27` | `PartyConnection.join/read/listen/send/participants/leave`，本地 SQLite 与远端 HTTP 共用接口 |
| 群聊存储 | `src/store/store.ts:16` | messages + participants；消息 seq 为游标，支持 since/before |
| 异步消息通知 | `src/server/wake.ts:17`、`src/server/api.ts:407` | 唤醒等待中的长轮询，不启动或执行模型 |
| 定向发送 | `src/core/types.ts:83`、`src/core/mentions.ts:22` | to 是路由视图；@ 是客户端解密后识别的正文提示 |
| React 群聊组件 | `src/ui/index.ts:23`、`src/ui/party/chat.tsx:40` | 正式导出 `agents-party/ui`；Chat 用 props 接数据 |
| Web 页面与增量消息 | `web/src/party-app.tsx:132` | 保留 PartyApp 和 Chat；长轮询追加消息，不是工具或 token 事件流 |
| 本地服务 | `src/server/http.ts:136` | Node HTTP + SQLite，可直接服务构建后的 web/dist；无需桌面或官方付费服务 |

主接入证据：<https://github.com/1gr14/agents-party/blob/af00afbd49b3235c2084cff9849ef12353073484/src/client/connection.ts#L27>

```txt
用户提交会诊 / 交叉质疑（适配行为待实现）
└─ PartyConnection.send(from, text, { to, replyTo })
   └─ PartyConnection.listen(forName, { since, timeoutMs })
      └─ [新增 Paws 适配层：去重、角色会话映射、单会话串行]
         ├─ client.sessions.spawn({ machineId, directory, agent })
         ├─ client.messages.watch(sessionId, { afterSeq, onMessage })
         ├─ client.messages.send({ sessionId, text, localId, images })
         └─ 对应 root turn 完成
            ├─ PartyConnection.send(...) → PartyApp.listenLoop → setMessages → Chat
            └─ Paws 执行记录 → [新增 Agent 详情面板，按 sessionId/turn 定位]
```

## 最小改造建议（待实现，不是已存在的函数）

1. **新增 Paws runner 适配层。**
   为每个 Party 参与者绑定真实 Paws sessionId，按任务消费群聊信息。
   使用现有 `client.sessions.spawn()`、`client.messages.watch()`、`client.messages.send()`。
   先订阅再发送；以当前提交 localId 对应的 root turn 结束事件判定结果，不能以首段文本、历史轮次或子 Agent 完成代替。
   同一 Agent 会话串行，不同角色可并行。授权请求交由人确认，不默认批准。

2. **保持消息与执行细节分离。**
   已完成的公开回答通过 `PartyConnection.send()` 返回 Party 时间线。
   原始工具事件、命令输出、错误和运行状态保留在 Paws 会话，通过独立授权的详情通道读取。
   记录 partyId / participant / runId / sessionId / rootTurnId / sourceMessageId 关联；不要只按 Agent 名字找最新会话。
   “完整细节”指引擎实际向 Paws 暴露的执行记录，不承诺模型未公开的内部推理。

3. **改原有界面，不另搭一个聊天产品。**
   `ChatProps` 增加打开 Agent 详情的回调；`chat.tsx:264,344` 当前点击姓名是选收件人，改为展开详情。
   底部原有 to: chips 保留定向发言功能。PartyApp 增加选中 Agent、运行状态和详情面板。
   原 `MessageText` 仅渲染纯文本；扩展结构化回答/图片展示时明确版本，保留旧文本兼容。

4. **贯通图文，而非仅加按钮。**
   `PartyComposer.onSend(text)`、`ChatProps.onSend`、`PartyApp.send` 都需扩展。
   Party 目前只有加密 text，没有附件协议；优先将版本化附件引用装入加密正文，另有受保护的附件存取通道。
   适配层读取图像字节后转为 Paws SDK `ImageAttachmentInput`。不要把 base64 图片或原始日志塞进约 1 MB 的 Party 文本上限。
   现有 Paws SDK 输入：最多 4 张 PNG/JPEG/WebP，每张不超过 10 MiB；具体引擎识图仍需实际验收。

5. **增加一个有边界的会诊模板。**
   拟定流程：主持人派发 → 30m/10m/1m 三角色并行分析 → 交叉质疑一轮 → 主持人汇总。
   用户不必手动 @；适配层负责定向投递，Agent 能看到需要讨论的共同材料与前轮发言。
   只投递明确的工作项，忽略 join/leave，设置轮数、超时和停止条件。不是每收到一句广播都调用所有模型。
   群聊通知已有；角色分工和上述会诊规则仍需少量业务代码，仓库不提供现成会诊调度器。

## 异步可靠性：不能混为一谈

- `listen()` 等到消息后返回；调用方需再次监听。
- 不传 since 时从“现在”开始，执行期间/重启前的消息可能跳过。需持久记录消费游标，先可靠入队再推进。
- 两个同名 runner 可以收到同一任务；没有任务租约/抢占。单实例 POC 应避免重复 runner。
- `send()` 每次生成新消息 UUID，无客户端幂等键。需要 sourceMessageId 去重和结果发送记录；不宣称端到端 exactly-once。
- Paws `sessions.stop()` 当前只是发送 session-end，并不证明远端进程已终止。POC 停止按钮应写“停止协调，远端可能继续”，并保留原会话入口。

## 需要先测试确认的上游风险

`web/src/party-app.tsx:163` 的接收流程和 `:275` 的发送流程都会覆盖 cursorRef。
可能顺序：收到截至 C1 的批次 → 解密等待期间别人发 C2 → 自己发 C3 并把 cursor 设成 C3 → 下一次请求 since=C3。
这时 C2 可能从未加载。此为源码推断，未动态复现。实施应先写回归测试，让接收游标只代表完整消费到的位置，并保证消息顺序；简单取最大值不能修复跳过。

## 部署与信任边界

- 建议把 Party 服务、SQLite 和常驻适配进程放远端 Mac，浏览器只负责展示/输入。
- Node 本地 SQLite 路径要求 Node ≥22.5，或 Bun；本机当前未找到 Bun，未为本审计安装依赖。
- **Paws SDK 连接远端会话，不是任意 localhost HTTP 反向代理。** 手机访问 Party API/网页还需要明确的认证网络入口，不能声称零配置已打通。
- 默认无 token 的 loopback 服务把本机请求当 owner；反向代理也来自本机，所以远端访问必须加认证与 TLS，不能直接转发无 token 服务。
- Party 参与者共享密钥，普通 from 身份自报；to 不是私聊保密或操作授权。Paws 原始细节不要广播进 Party。
- 不照搬默认 Dockerfile 发布 fork：它安装 npm 官方包，不会编译自定义源码。

## Paws 对照位置

基线 `/Users/jacky/jacky-github/happy`，HEAD 与 origin/main 均为 `29884a03a2be7c57d3770f6c273ca50688348d25`。

- `packages/paws-agent/src/resources/sessions.ts`：spawn、resume、stop 的实际语义。
- `packages/paws-agent/src/resources/messages.ts`：图文发送、加密上传、历史与 watch。
- `packages/paws-agent/src/client/types.ts:102`：引擎枚举、图文输入与订阅契约。
- 旧 POC 的 `remoteAgent.ts` / `protocol.ts` 可作为 Paws 适配参考；不迁移其 LangGraph 调度，旧 fixture 测试不能代替本方案的真实 Agent 验收。

## 实施验收门槛

先验证：真实 Paws 单 Agent 回答进入 Party 时间线，点击能定位同一会话的真实执行记录。
再验证：同一套 Mock 图文证据发给三个真实角色，存在一轮真实交叉讨论，主持人汇总可追溯。
最后验证：断线补读、不重复执行、失败/权限待处理/停止状态准确，无无限互聊。

本轮验证方式为主 Agent 与两路独立 sub-agent 的源码交叉核查；没有声称编译通过、浏览器验收通过或真实模型跑通。未改 Happy 项目代码，未提交、推送或部署。

## 已批准的实施落点

用户于 2026-09-16 确认“按这个方案开始魔改 AgentParty POC”。
新包 packages/paws-agent-party，隔离分支 feat/agentparty-poc，独立于旧 LangGraph POC。
以 vendor/agents-party 保存上述提交实际使用的上游源码、MIT 和 provenance；不引入未使用的 CLI/MCP/Point0 构建链。
保留上游 Chat/Composer/Sidebar 和消息总线；Node 服务、Party SQLite、Paws 适配在同一执行机常驻，前端沿用 React + Tailwind。
默认仅绑定 127.0.0.1，随机访问 token 保护全部 API；不新增公网入口。扫码经 SDK 正常授权，账号凭据默认仅内存，不借用其他应用私钥。
POC 重启保留群聊/执行关联，但进行中任务标为 interrupted，不自动重发模型任务；明确要求重新授权，用户可重新发起，不承诺自动恢复执行。
先 single 验证一个真实 Agent，再 consultation 八轮（主持人开场 + 三路分析 + 三路交叉质疑 + 主持人总结）。
图像用独立受认证附件接口存远端；Party 只存版本化文本/附件引用；每次实际模型调用仍通过 Paws SDK。
Paws 详情从 SDK 历史分页读取，原始消息不广播到 Party。不扩展新的通用自动规划框架。
浏览器测试的测试替身仅允许在 test/ 入口注入；正常启动无模拟 Agent 开关，不将测试替身当真实验收。
