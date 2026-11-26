# 原话卡片下载与字幕修复 · 2026-11-27

## 结果与边界

网页整组ZIP下载已修复并实际保存成功。新增保守的画面字幕核对，真实新制作修正8个字幕段，重新生成5张卡片并完成上传、网页回显和ZIP保存。44项网站/流水线测试通过。

**字幕并非全部校对完成**：无充分证据的“主量”“包开”等仍保留。画面字幕本身也可能有错，本次没有逐字听校；页面及归档保持待核对/review。本次未推送、PR、合并或生产部署，未验用户当前手机/Air。正式服务、旧图库、其他worktree未改动。

基础实现与之前执行证据见[原报告](video-card-studio-20261126.md)。本报告取代其中“浏览器ZIP未通过”的当前状态，保留其历史观察。

## 改动

- 网页整组下载改为有界fetch→完整Blob→浏览器下载。限制65MiB，校验HTTP状态、MIME、声明/实际长度和ZIP签名；超限取消读取，截断/HTML不生成下载。一次准备一组，错误显示重试，离页取消并清理Blob。成功提示只表示交给浏览器，不假称磁盘保存。
- 每个ASR段取三个原帧，系统Vision OCR提出少数汉字替换。至少两个不同帧相隔0.2秒且高置信一致；限定锚点和每段最多两字，保护数字/否定/条件，不插入删除或改时间。任一清晰帧支持原文时否决冲突。
- 原生Codex直接看候选原帧，只能接受/拒绝既有候选，禁止自由改写及工具。样本中OCR会把“它”识成“亡”，冲突保护阻止此替换；不能把多帧OCR一致当成绝对正确。
- 新流水线版本2分离不可变ASR与最终字幕。原转写、改前/后、时间、帧、模型判断、摘要保留；恢复校验不会因合法纠错破坏前阶段摘要，资料被改则阻止恢复。旧版本1沿原字幕与原摘要恢复，不悄悄插入新阶段。
- 默认macOS需Command Line Tools及Vision。编译显式选择实际SDK与支持的macOS目标；OCR关闭/不支持时明确unavailable，失败不伪造成功。没有周期业务轮询。

## 下载诊断证据

同一ZIP的attachment、inline、octet-stream均复现浏览器取消；诊断PNG attachment也取消，原站inline PNG可保存。浏览器出现Range请求，但补206/Content-Range仍取消，**Range不是已证实根因，产品没有加该改动**。

浏览器fetch完整读取后Blob保存成功；随后已在实际网站新按钮验证两组真实成品，未修改全局下载策略或绕过权限提示。底层Ego直接网络附件取消的原因仍未证实。

| 实际网页保存 | 字节 | SHA-256 |
| --- | ---: | --- |
| 原五图ZIP | 4,532,504 | `0b13378afbf148f91ae97fad56dcfe27aff8c13ea096a91d3e37c68c69885aad` |
| 新字幕核对版ZIP | 4,530,462 | `f5541866a4083aa7bfce99da817e8ef0e060d819a4bde3db1292e76c51fac519` |

均由Ego下载事件在同一轮saveAs落盘，failure=null，与服务器字节摘要一致，5个PNG的`unzip -t`全部通过。HTTP成功没有代替浏览器保存证据。

## 真实新执行

- 宿主：Mac mini / macOS / Node24.20.0；worktree `happy--task-webhooks-20261126`，基础提交`f0f548c81`加本轮工作区修改。外盘UUID再次核对正确。
- 网站`127.0.0.1:65200`，隔离API`127.0.0.1:61309`；不是公网入口。
- machine `e3735b6f-021c-4d95-864b-6e5ffe104ab1`，task `9e3b80e9-0d7f-4946-a80c-66db5a175da3`。
- job `47058ca8-658f-4d48-8b83-2ee8311d77b3` → run `8c82004e-2bda-4575-a876-b4ab5f2955f3`。
- 2026-11-27北京时间01:09:24页面提交；01:12:47完成。事件依次为queued→dispatching→waiting→source→transcript→proofread→plan→frames→selection→cards→upload→completed；daemon也报告completed。
- 重新采集`BV1Ty4y187Rg`，使用本轮原始音轨转写及本轮模型/选帧/排版，未拿旧PNG冒充新结果。
- 8段修正含“分辨→粪便”“包→剥”“易→宜”“凉白菜→凉白开”“最有→会有”。其余具体候选和原图依据归`transcript-proofread.json`。3批看图判断全部turnCompleted、toolCalls=0；不是人工听校。
- 新5图逐张查看：宽1080，4张高1440、1张高1774，原帧/水印/黑底白字保留；页面来源、时间点与新清单相符。所有图入Image OPS并读回摘要，approval=review。

代表图“凉白开”资产：`img-ce449435e9b2bb915cc73dc40d32cfc2bdae33d1bfbd5f8701514027678b739c`。全部ID在私有`fix-20261127/archive.json`；不代表用户认可。

## 自动化检查

`node --test examples/video-card-studio/*.test.mjs examples/video-card-studio/pipeline/*.test.mjs`：44/44通过，比原33项新增11项。

新增覆盖完整/截断/异常/超限下载、重复帧与低置信拒绝、数字/否定/条件保护、OCR冲突、候选模型输出越权、不可用标记、新阶段摘要恢复/篡改阻断、旧任务兼容。页面JS语法与diff检查通过；Swift本机实际编译/OCR完成。没有改共享Server/CLI包，沿用原报告对应测试与typecheck证据，不冒充本轮重跑。

## 证据与收尾

私有证据根：`.card-studio-validation/fix-20261127/`，含下载诊断、模型对照、OCR实验、`tests.tap`、两组浏览器ZIP、摘要、`new-job-events.json`、`new-job.json`和归档记录。新执行目录：`.card-studio-validation/runtime-1795712576415/`，其中`paws-events.json`记录真实machine和终态。

Ego沿数字空间108及本会话唯一runId，准确核对目标/URL；提交、采集、两次下载完成均已report_browser_step。最后网页状态为新任务完成、制作连接正常、新五图可见；随后独立finish空间108。

本轮两个隔离harness和诊断服务的精确PID已退出，四个对应端口单次连接均拒绝，两轮临时`access.key`均已删除；证据`fix-20261127/cleanup.json`。网站已经停止，不是持续可访问入口。保留本任务图片、SQLite、模型证据及原Keychain条目，未清理其他服务或账户。

Ego `video-card-studio/submit-and-save-card`、Happy `execution/diagnose-integration`和Image OPS `video-subtitle-cards@1.0.0`已写回本轮事实/边界并同步索引。Image效果校验96项通过；Ego全库仍有4项、Happy全库11项未修改条目的静态错误，本次条目未报错。知识文件已保存，不把全库校验写成通过；完整输出保留在私有证据目录。
