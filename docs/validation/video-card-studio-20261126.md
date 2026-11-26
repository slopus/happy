# 原话卡片网站验证记录 · 2026-11-26

## 当前结论

后续状态更新：2026-11-27已修复网页ZIP保存并实际通过，新增画面字幕核对、重新制作五图。详见[修复验证报告](video-card-studio-fixes-20261127.md)。下文保留2026-11-26的原始结果；字幕仍未完成逐字听校。

通用固定本机程序执行器、任务级 SSE、独立匿名网站及视频制作适配已实现。本分支的隔离 HTTP → 新代码 Server → 指定 daemon → 原生 Codex / Whisper / FFmpeg / Pillow → 上传 → completed / 网页显示链路实际通过。浏览器单 PNG 保存通过，**整组 ZIP 的 Ego 下载事件仍为 canceled**；HTTP ZIP 下载及解压通过，不合并成浏览器 ZIP 已验。

未推送、未创建 PR、未合并、未覆盖生产 Server/CLI、未生产部署网站；未在用户当前手机/Air 验收。不是用户可远程访问的公网入口。原大麦图库源码和生产资源未修改。

## 源码与宿主

- worktree：`happy--task-webhooks-20261126`，分支 `task-webhooks-20261126`。
- 基础：`42785de5fa5a33cb4382c456639d0bb07e84fe9d`；通用 Webhook 基础提交 `2f1d67dba`。
- 本报告对应后续独立网站/固定执行器提交；真实执行时为该 worktree 的构建产物，未使用旧正式版冒充。
- 宿主：Mac mini / macOS / Node 24.20.0，外盘 UUID 已再次核对为 `AE0665BA-321F-4964-B0F8-122BFABE7178`。
- 已实际执行 pnpm 安装、happy-wire / CLI 构建。CLI 测试全局准备重建了本 worktree 的 CLI 与 paws-agent；没有改正式发布目录。

## 自动化验证

| 范围 | 结果 |
| --- | --- |
| `node --test examples/video-card-studio/*.test.mjs examples/video-card-studio/pipeline/*.test.mjs` | 33/33 通过 |
| Server `taskWebhookRoutes.spec.ts`、`scheduledTasks` | 45/45 通过 |
| CLI `localHandler.test.ts`、`runner.test.ts` | 12/12 通过，含真实子进程 |
| Server / CLI `tsc --noEmit`、Owner配置脚本单独typecheck | 通过 |
| 页面 JS 语法、`git diff --check` | 通过 |

这是本轮 90 项定向回归，不是全仓测试全绿。基础 Webhook 的既有证据另见 [原报告](task-webhooks-20261126.md)：曾跑全量 Server 时有一项独立 AI-service smoke SDK 准备失败，不能把该次执行改记为全部通过。

覆盖输入、凭据、账号/任务隔离、持久化/幂等、排队/背压、旧 daemon 协议隔离、过期启动拒绝、回执恢复、终态、撤销流、结果并发、PNG 格式、ZIP/慢下载限制和未知 HTTP 结果。限额测试使用真实 HTTP 与 SQLite；模型/视觉夹具测试不当作真实制卡质量证据。

## 独立评审与修复

独立只读评审返回 6 项 Important、2 项 Minor。以下均已核对并改动，未把评审本身当作测试成功。

| 发现 | 修复与验证 |
| --- | --- |
| 陈旧/损坏回执挡住整机领取 | 持久 ACK、永久拒绝记录、逐回执隔离；坏文件保留以禁止重放；测试通过 |
| 批量领取后长任务耗尽后续启动期 | 新 daemon `maxNewClaims:1`，交付结束事件驱动下一槽位；spawn 前核对 Server 实际返回状态；多任务/过期/uncertain/cancelled 测试通过 |
| complete/fail 与上传额度竞态 | 每 job 串行、run/state 条件写入、原子图片文件与 ZIP；互斥提交和跨额度并发测试通过 |
| 202 丢失或异常响应卡队列 | 捕获请求/解析/缺字段，保留原 ID；显式重连替换流；已提交后丢回执、未提交/HTML/截断/缺字段测试通过 |
| 删除任务仍能读状态 | 删除事务撤销凭据；读取与发送前复核授权；轮换/禁用/删除与其他任务隔离测试通过 |
| ZIP 反复内存打包、媒体下载后才限额 | ZIP 完成时缓存、流式响应、并发8；媒体流传输中限512MiB；慢客户端/超限中断测试通过，新媒体采集实跑通过 |
| 原文子串可能切掉否定 | 只接受完整字幕段；截去条件的原文子串被拒绝；跨段语义仍需要人工校对 |
| PNG 像素结构未完整校验 | 限非交错8-bit RGB/RGBA，验证扫描行长度、滤波、CRC和解压边界；损坏像素测试通过 |

另修复了制作失败后共享浏览器上下文未更新、390px队列撑宽至700px的问题；真实新制作和390px布局分别复验。

## 真实执行记录

私有原始证据位于 worktree 的 `.card-studio-validation/`（Git 忽略，无密钥入库）。第一轮与修复版重启采用各自独立 PGlite、测试账户、HAPPY_HOME_DIR 和 daemon。网站 SQLite 由本任务显式复用，以验证历史保留。

| 轮次 | 入口与宿主身份 | 结果 |
| --- | --- | --- |
| 第一轮 | API `127.0.0.1:65133`，网站 `127.0.0.1:65200`，machine `f2aa5445-d81d-45b8-9425-72008c82fdef` | 两个不同视频一运行一排队；重复请求只一个 run |
| 修复版 | API `127.0.0.1:61334`，同网站端口，machine `290d2a42-36cf-4938-a5fb-4f48698a86ea` | 重启保留历史；重新提交真实制卡完成；owner配置/轮换/撤销和通用程序执行通过 |

第一轮：

- `BV1Ty4y187Rg`：job `186bacf0-10f4-4ca1-9348-05429eec8643` → run `8f3aac0a-687e-45e7-957d-e51babbd0538`，生成5张、上传成功、completed。
- `BV1px421k7gq`：job `3866a76a-a871-45c9-82e0-5cf3973c9b0e` → run `36472327-6cc6-486a-8078-105519be981f`。自动出队，采集/转写/规划实际成功；一次有界重新提帧后仍有一组不合格，准确 failed，未上传伪造图片。**第二输入没有丢失，但制卡未成功。**

修复版：

- task `e4137efe-adf2-4c5f-95f5-91a2c2905245`，job `d71c22bd-36e2-444a-bc1a-689410b08ebf` → run `84bff4ae-ae0b-4733-bb51-d775481f40b8`。
- 同一个公开视频重新执行完整链路，5张新卡片 completed；不是复用上一轮 PNG 冒充新执行。
- 原生模型回执显示 turnCompleted、toolCalls=0；源文件/字幕/计划/选帧/成品有各自摘要和时间轴。
- HTTP 重复 ID 返回同 run；ZIP 4,532,504 bytes，5个PNG均 `unzip -t` 通过。
- `configure-task-handler.mts create` 创建另一通用 `/usr/bin/true` 固定程序；两份不同 input 均真实执行 completed，相同 ID 重复返回原 run。随后 rotate 后旧凭据401，unregister 后新凭据401，仅本任务登记被移除，视频程序登记保留。没有打印 token。

精确记录：`runtime-1795704813967/paws-events.json`、`runtime-1795706595260/{paws-events,http-evidence,browser-download-evidence}.json`、后者的 `owner-setup/{evidence,rotation,revoke}.json`。配置引用和凭据原件分离，原件在 Keychain；临时 Paws access.key 在隔离 harness 停止时删除。

## 网页、下载与图片

- Ego task space100，本会话独立runId；每次控制和截图核对准确目标及URL。关键帧已通过 Happy report_browser_step 上报，未作为普通图片重复发送。
- 真实输入、两条请求排队、5图回显、修复版历史恢复与新提交、媒体采集、最终5图和390px布局均有已验证关键帧。
- 390px最终 `innerWidth=clientWidth=scrollWidth=390`；队列在自身350px区域滚动，不撑宽整页。属于桌面浏览器模拟窄屏，不是手机实机。
- 浏览器单图实际保存1,128,383 bytes，SHA-256与manifest一致。
- ZIP浏览器下载反复返回 `canceled`，即使HTTP和ZIP格式通过，也保持浏览器ZIP未验；未改全局下载设置或绕过浏览器限制，原因尚未确认。
- 五张新PNG逐图检查：宽1080，4张高1440、1张高1774；原画面/水印/黑底白字保留，未把原画面重绘。ASR存在“分辨/粪便”“包/剥”“凉白菜/凉白开”等同音字问题，未做逐字听校，不能称准确原文。
- 新5图已Image OPS归档并读回核对，approval=review。代表图已通过Happy send_image交付；资产 `img-d218ff4c61d0badeddbc69ce67f42dcaec100b35a5b5c8669880fb0f87893d44`。其他资产ID在episode的`image-ops-archive.json`，不是用户已认可记录。

## 交付边界

仅源码与隔离真实验证。外部公网部署、正式服务升级、当前用户设备和持续无人值守未执行。网站/Server事件源当前是单进程；连接结束后显式重连，无周期业务轮询。配置及恢复说明见 [README](../../examples/video-card-studio/README.md)。

## 收尾补修与知识记录

- 空闲连接诊断：Node 24.20.0 / Undici 7.29.0 的单次 SSE 实验在301,433ms后返回 `UND_ERR_BODY_TIMEOUT`。新 `events.mjs` 使用原生 HTTP 流，仅建连/响应头有一次超时；不重连循环、不新增业务轮询，并拒绝重定向携带凭据。新增真实 HTTP 的空闲事件、取消、建连超时和重定向边界测试，网站套件由30项增至33项。
- 修复后第三轮隔离环境：API `127.0.0.1:55162`，machine `8e3eb461-a88f-403c-b4bd-612a4d2543f0`，task `150e7436-fa25-4ed6-aee9-ee25f06e4c19`。两次单次快照之间空闲330,013ms，均为connected，三条历史状态不变；证据 `runtime-1795708133127/idle-sse-evidence.json`。不把这个有限观察外推为长期无人值守或反代长稳。
- 验证脚本改为从显式 `CARD_STUDIO_CONFIG` 读取非秘密运行时引用，不在源码写死机器路径或Happy capture session身份。该配置版隔离 harness 已实际启动，复用本任务SQLite历史；此前完整五图仍属前一轮真实执行，不冒充再次生成。
- 本次形式选择已按任务范围写入 Confirmation OPS；Happy执行集成、Ego原话卡片站点、Whisper、Image效果卡与Account Pool平台档案均维护了证据指针。Account Pool注册表/9项单测及Image效果结构校验通过。
- Ego与Happy全库校验仍有本次未改动条目错误；本次新增站点和修改项单独核对，不能将全库记为通过。具体校验结果保存在私有证据目录，不自动修改其他任务正在维护的知识。

## 最终状态与精确清理

最终 Ego 页面重新核对“制作通道已连接”，新五张卡片可见且均为1080宽，页面无横向溢出；新关键帧已报告。一次等待所有懒加载图片解码的检查超时，未冒充截图成功；随后只核对可见内容并取得有效新帧，旧组屏外的懒加载图片未纳入该次检查。原任务空间100已在独立调用中结束。

最后两轮隔离 harness 及对应 daemon 已退出，网站和两个隔离API端口单次连接均拒绝；三轮测试的临时 `access.key` 均已删除。结果图片、SQLite、脱敏证据和Keychain旧条目按归属保留，未停止或替换正式worker。网站此刻已停止，不是持续可访问的交付入口。精确收尾证据为 `.card-studio-validation/cleanup-evidence.json`。

OPS写回文件已保存；新增Ego站点在原校验器中无自身错误。Ego全库另有4项、Happy全库另有9项未修改条目的静态校验错误，保留为未完成维护项，未冒充全库校验通过。
