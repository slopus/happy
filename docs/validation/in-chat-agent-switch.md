# 同聊天切换 Agent 与独立新建入口

初版 PR #907 已合并为 `e3ca0cf5d5e3b4efdfb31b9c94bfad4dd2b2b8f8`；本轮继续修复正式验收发现的旧 schema 写回问题。对应研究：外盘 `t3code-context-handoff-research/2026-11-25-followup.md`。

用户契约：选择 Agent/model 只暂存；点击普通发送箭头/Enter 才在当前逻辑聊天接手。保留旁边明确的新建会话按钮，继续创建独立会话。内部执行会话保留独立身份和加密历史；本次先复用现有有界历史接续，不宣称实现 T3 全量原文回查或旧原生线程增量恢复。

| Case | 通过标准 | Base/Before | 独立验收 | E2E | 交互评审 | Video/After |
| --- | --- | --- | --- | --- | --- | --- |
| S1 暂存与取消 | 选择/取消不 spawn、不改变源执行者或草稿 | base 模型选择器 | pending | pending | pending | pending |
| S2 同聊天发送 | 箭头/Enter 才启动目标；URL 与逻辑聊天身份保持、旧历史可读、发送/审批/停止指向目标 | base 新建按钮 | pending | pending | pending | pending |
| S3 独立新建 | 单独品牌按钮创建独立会话、保留来源和原草稿；不折叠进源逻辑聊天 | base 新建按钮 | pending | pending | pending | pending |
| S4 安全边界 | 运行中/待审批/队列未空拒交接，旧页不能向过期执行者误投 | base | pending | pending | not-required（逻辑） | not-required |
| S5 失败重试 | 未发送退出释放占用；服务端确认后才发布目标；重试不重复 worker/prompt | base | pending | pending | pending | pending |
| S6 统一身份 | 侧栏/搜索/历史单行；标题/组织归 root，执行动作归 current，普通新建保持独立 | base | pending | pending | pending | pending |
| S7 组生命周期 | 归档/删除按完整已验证组；部分删除后从持久计划恢复，不误删独立分支 | base | pending | pending | pending | pending |

## 实现与验证状态

源码已实现。测试、独立 review、真实浏览器与发布分别记录，不以测试桩推理或旧正式版本代替当前代码真实切换。

阶段记录：22个定向suite共529项通过；完整App TypeScript与Expo Web export通过。后续审查补充旧客户端生命周期及claim未知结果回归，精确最终数量以发布记录为准。

Ego组件验收已通过：两入口与Enter分流、Tab不建新会话、busy禁用、取消保留草稿、空输入区分、桌面/390px几何、focus提示及reduced-motion。宽屏独立PC组件评审通过；合成提交端不代表完整App或模型交接。组件8秒H264/yuv420p/1680×920状态回放完整解码通过并已通过Happy发送，手机实际播放未验。

- 选择与两动作、键盘、草稿清理：实组件和 hook 回归。
- 稳定 root、原始加密 session 与执行归属分离；展示投影不改 raw store。
- root CAS 占用、服务端交付证据、失败保留同一请求，以及旧页面的单次权威读取。
- 初版已正常合并并通过正式 Web/preview/production 的制品校验；真实验收发现下述归属恢复缺陷，修复前不称完整交付。未修改后台 CLI。

## 能力边界

本次继续复用24k字符文本接续，旧原生线程不复用，工具与历史附件不迁移，源idle worker保留。客户端单次权威读取与CAS不等于服务端线性化锁。进程硬崩溃或投递结果未知时保留pending、不自动重放；可读到首条服务端交接证据后才恢复提交。切换到删除计划期间的操作失败关闭，不回退旧worker。

## 独立评审

最终独立代码评审通过，无未修P0/P1或阻断P2；旧页面生命周期旁路和root CAS未知导致隐藏候选两项均已修并复审。source输入框PC组件独立评审通过，focus与reduced-motion反馈已补修后Ego复验。真实完整App/模型、双设备及原生设备需在正式发布后分别验收；不能用此结论扩大验证范围。

## 正式模型验收与兼容恢复

在正式 Web、Mac mini、专属合成聊天中，源 Codex 记住三项随机事实。选择 Antigravity 只暂存、取消保留原草稿；实际普通箭头发送后同一 root URL 保持，Gemini 4 Neon 准确答出三项事实并完成。但旧 schema 客户端的消息时钟写回可能删掉新成员归属字段；root.active 仍指向目标，严格路由因字段遗失显示 unavailable，列表拆为两条。Retry 与完整刷新都未恢复。该轮只证明模型接续，不能作为同聊天通过。

修复要求：依权威 root.active、完整 predecessor 链、机器和目录确认缺失归属；冲突、歧义、循环或缺段仍拒绝；提交前重新核对保留位与目标，恢复不重发已交付消息。普通独立新建没有 root.active claim，不因 continuation 血缘被折叠。旧客户端仍运行旧代码时不能宣称服务端线性化防护；本次特定写入设备没有识别。

精确发布、OTA、正式复验与清理状态唯一记录于本机 Release OPS 的 `local/projects/paws-in-chat-agent-switch-20261125.md`；该记录不包含凭据。
