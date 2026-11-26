# 视频原话卡片网站 Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans in this isolated worktree. 用户已要求直接实施，正常实现选择自主处理，不重复请求开工许可。

**Goal:** 访客提交 B 站链接后，经 Paws 的任务专用 Webhook，在指定本机生成原画面与精选原话长图，网站显示进度并提供下载。

**Architecture:** 独立 Node 24 网站保存 SQLite 队列和图片，任务密钥仅在后端内存。Paws 提供任务级状态事件；daemon 运行本机按任务登记的固定程序，外部数据只从 stdin 进入。程序获取任务、采集视频、本地转写、无工具 AI 选段/选帧、确定性排版，再向固定网站上传产物。业务代码位于 examples/video-card-studio，不修改旧图库。

**Tech Stack:** Node 24 / node:sqlite / HTTP + SSE / Paws daemon / Ego / FFmpeg / MLX Whisper / Codex 原生结构化输出 / Pillow。

**Spec:** 本文记录当前实现约定；基础 Webhook 见 ../../task-webhooks.md。

## Global Constraints

- 用户选定：原视频画面＋精选原话，沿用大麦卡片形式；原话不改写，来源和时间点在页面可回查；自动转写仍标明待核对。
- 所有制作在独立目录，旧图库源码、资料、认可状态和生产站点不改动。
- 不启用 bypass；本机固定程序是所有者显式登记的可信代码，使用 daemon 的 OS 身份，不宣称其拥有额外沙箱。AI 选段进程禁用工具，外部链接不成为 shell、路径或权限配置。
- 公开访客只提交 canonical BVID；第一版只支持公开单 P、最长 60 分钟；不接受回调地址、命令、目录、字幕指令。
- 任务仅匿名公开使用，不公开后台凭据；页面不储存任何执行密钥。
- 一次一项制作；网站持久化排队，Webhook 409 不丢输入；同请求 ID 幂等；不确定状态停下供所有者核对，不自动重做。
- 不实现周期业务轮询；提交、SSE 事件、连接建立、手动恢复驱动。
- 先验证本分支隔离 Server/daemon，生产 Paws 和新网站上线分别待正常发布流程；不修改正式 daemon 或已有 worker。

## Review Focus

- 重启/HTTP 响应丢失：相同 ID 续接，未知执行保持 uncertain。
- 越权/路径注入：任务身份、注册程序及目录必须匹配；访客不能改变执行配置。
- 队列忙碌、离线和撤销：真实状态清楚可见，待处理输入保留。
- 恶意或错误产物：仅限本任务、限定大小的 PNG，完成必须校验所有图片及 manifest。
- 多访客/长视频：容量、速率、并发和时长有硬上限；失败不泄露密钥或本机路径。

### Task 1: 固定本机执行与任务级事件

Files: happy-wire scheduledTasks；Server scheduledTaskRoutes/store；CLI scheduledTasks runner/localHandler。

Interfaces: executionKind=local-handler（默认仍为 agent）；加密配置 localHandlerId；本机注册记录按 server/account/task 作用域匹配固定 executable/args/directory。stdin={taskId,runId,input}；exit 0 是程序完成，异常退出 failed，交付未知 uncertain。GET task-webhooks/:taskId/events 使用相同 Bearer，仅返回脱敏 run 状态。

- [x] 测试：未登记/其他任务拒绝、数据不插值、真实子进程、终态回执恢复、旧 daemon 不领取、本机模式与 AI 会话模式隔离、撤销事件连接。
- [x] 实现并运行 wire/Server/CLI 定向测试及 typecheck。

### Task 2: 网站与制作适配

Files: examples/video-card-studio/{server,store,dispatcher,worker,pipeline,public}；README。

Interfaces: POST /api/jobs {requestId,url}；GET /api/events；GET /api/jobs/:id；GET 单图/ZIP。私有 worker API Bearer 与 Webhook 凭据分离，绑定本次 job/run，固定目的地，禁止传入 URL。SQLite 先持久化后触发；有界 FIFO，未知状态阻断自动重投。

- [x] 测试：输入、跨 job 回传、幂等、两个输入 FIFO、重启恢复、忙碌/失败/uncertain、实际 HTTP 图片/ZIP与SSE。
- [x] 复用制卡实现但移除作者限制和旧图库发布副作用，读回真实来源/字幕/帧/图片。
- [x] 实现响应式中文页面，输入/队列/失败/结果可操作；不显示内部部署参数。

### Task 3: 隔离真实执行与交付

- [x] 真实 HTTP → 新代码 Server → 正确隔离 daemon → 固定程序 → 原生 AI / 原画面制卡 → 上传 → 页面及下载。
- [x] 重复与两个不同输入、队列不丢失、重连/重启边界；记录实际验证范围，不把夹具当真实制作。
- [x] Ego 核对页面、单 PNG 实际保存和390px布局，按本会话规则上报关键帧；五图归档 Image OPS，保持review。
- [x] 整组 ZIP 浏览器保存：2026-11-27网页改用有界fetch/Blob，旧/新两组实际保存、摘要及解压通过；底层直接网络附件取消原因仍未证实。
- [x] 新增原帧OCR候选＋无工具看图复核，实际修正8段并重新制卡；保留ASR、时间轴与恢复摘要，旧任务不自动迁移。
- [x] 文档、源码 review、相关 OPS 写回；不自动生产部署。

## 执行记录

- 2026-11-26：基础 Webhook 2f1d67dba 已通过隔离 Codex 回复链路；后续网站、固定程序与任务SSE已实现，独立评审的6项Important与2项Minor已修复并回归。
- 2026-11-26：新代码完整真实制作五图并显示；两不同视频输入均保留，第二条质量门禁失败被准确标为failed。Owner配置/轮换/撤销和两输入固定程序执行完成。
- 2026-11-26：页面空闲后断开，独立一次连接实验确认Node原生fetch在约301秒以UND_ERR_BODY_TIMEOUT结束SSE；改用原生HTTP事件流，新增3项回归。总计90项定向测试通过，源码与真实验证详见 ../../validation/video-card-studio-20261126.md。
- 2026-11-27：44项网站/流水线测试通过；新一轮HTTP→指定daemon→真实制作→completed→网页→ZIP保存通过，详见 ../../validation/video-card-studio-fixes-20261127.md。
- 交付边界：字幕仍有证据不足的错字待听校；无公网部署、正式服务升级或用户当前设备验收。
- 架构选择：独立 Node 服务优先复用现有栈，SQLite 单进程队列可在本机隔离实测；暂不引入 Cloudflare 工作流。新网站公网宿主和域名留待具体发布准备后落实。
