# Paws 与 Magpie Token 统计核对

2026-11-25。状态：诊断与源码方案核对完成；业务代码、运行配置与线上功能未修改。

## 结论

截图的 12.11 亿主要来自缓存读取。Paws 使用 Codex 原生含缓存输入口径；Magpie 主 tokens 为非缓存输入加输出，缓存另列。统一目录、时间和缓存口径后，Paws 比 Magpie 少 378,480 token（约 0.0312%），差额已全部定位到一笔压缩请求及一条新格式用量记录，没有发现截图总量被明显重复累计放大的证据。

Paws 的 Google/QQ 标签控制上方订阅 quota，热图来自本机全部扫描日志，含多个账号及子会话。热图总数不能解释为所选 Google 账号的消耗，token 总量不能换算为订阅百分比或实际扣费。

## 同口径数值

机器：本次执行机。自然日：2026-11-25，Asia/Shanghai。固定截止：19:00:00 +08:00。Paws 基线提交 `3ae7e4eaac985f89c152f9f14cb2f7af445d536f`。

| 指标 | Paws | Magpie 扩展读取同批日志并合并网关 |
|---|---:|---:|
| 非缓存输入 | 19,365,328 | 19,624,361 |
| 缓存读取 | 1,191,139,072 | 1,191,256,576 |
| 输出（已含推理输出） | 4,001,288 | 4,003,231 |
| 总处理量（含缓存） | 1,214,505,688 | 1,214,884,168 |
| 非缓存输入 + 输出 | 23,366,616 | 23,627,592 |
| 计入事件/账本行 | 5,716 | 5,720 |
| 归属的原生会话 | 103 | 41 |

缓存占 Paws 含缓存输入约 98.4%。总处理量差 378,480（相对 Paws 约 0.0312%）。会话归属与主/子线程处理不同，不能将 103 与 41 直接当作重复请求数量。

Magpie 来源拆分：

| 来源 | 行数 | 含缓存总量 |
|---|---:|---:|
| 直连 Codex 本地日志 | 5,646 | 1,200,311,750 |
| happy-codex 网关 | 74 | 14,572,418 |
| 合并 | 5,720 | 1,214,884,168 |

网关 74 行包括 73 条 HTTP 200、1 条 HTTP 499。直连日志的 status=0 为本地来源占位，不能解释成 5,646 条 HTTP 成功响应。与 Paws 的差额可拆为网关相关 268,614 和保留日志相关 109,866。

网关的 3 条额外记录已逐条定位：一条 `kind=compact`、HTTP 200，输入 267,246（含缓存 16,384），输出 1,368，总计恰好 268,614；Paws 原生 token_count 未包含对应一组用量。另外两条是 0-token 的 composer_predictions/499 和普通 200 空 usage，增加行数但没有增加 token。因此该部分确为 Paws 未覆盖的上下文压缩请求，不是重复累计。

保留日志的额外一条发生于 18:22:59 +08:00，非缓存输入 8,171、缓存 101,120、输出 575，恰好合计 109,866。已在原生日志定位到唯一 `type=token_usage_record`，其 `payload.usage` 的输入 109,291、缓存 101,120、输出 575、推理 266、total 109,866 精确匹配。Paws 只接受 `event_msg.payload.type=token_count`，整条新格式被跳过；Magpie 支持该格式。CSV 中 `kind` 为空，不将其擅自称为第二次压缩。

截图扫描于 18:54:17；本报告固定截止 19:00，所以与截图有少量后续活动差异。

## 方法与验证

1. 保持根工作区 clean main，报告位于 sibling worktree。
2. 核对本机 Magpie 0.1.4178；用 Go build info 绑定真实构建提交 `90efddabae4e1ac9bb97ab9beb9f5296133caba1`，没有把最新 main 行为当成本机行为。
3. 运行 `magpie usage --csv today`。其默认读取范围不覆盖 Paws 所有保留日志，不能拿默认总量与 Paws 直接比较。
4. 仅在各个只读 CLI 子进程中将 `CODEX_HOME` 指向 5 个 Paws 账号保留根，重复取得 CSV，按 session/time/response/model/token 字段去除跨扫描重复行。保留 Codex 直连来源，与 Magpie 自带已匹配网关去重后的网关行合并；排除 Antigravity 等其他执行器。
5. 将 Paws 原 collector 在内存中增加同一截止时间过滤，不修改源码；读取默认目录和同一组保留根，60 天回看以保留跨日累计基线及父历史。
6. 对真实日志独立核对：188 文件约 2 GB；5,631 个有前值的今日事件中，累计差额与 last 完全相等，0 次计数重置；85 个今日首事件合计 9,227,152。514 条非零 last 但累计不推进的快照被正确跳过。62 个今日有用量的 fork/子线程均找到父记录，当前过滤与全局去重没有改变这些今日事件的计数。

以上未读取或输出对话正文、认证材料；未发送测试推理请求，未更改 Magpie 读取权限、账号或设置，未做部署或浏览器操作。

## 已复现的统计边界问题

这些是纯内存夹具复现，主要引起少计，未证实它们影响本次真实总量。

1. `codexUsage.ts` 的全局 usage fingerprint 不含逻辑 session ID：两个独立 session 同毫秒且用量相同时，应 200，实际 100。
2. 正常 `thread_spawn` 被纳入 fork parent 分支；父历史不可用、两个真实事件间隔 500 ms 时，被一秒 burst 启发式丢弃，应 150，实际 0。
3. 累计值 100→250，last=50 的缺失事件场景，当前优先累加 last 得到 150，未报告相对累计值的 100 差额。修复应区分缺失、重置和回执修订，不盲目用累计差值覆盖所有请求。

源码入口：`packages/happy-cli/src/codex/codexUsage.ts` 的 `sessionMetadataFromRecord`、`addCodexUsageLine`、`usageFingerprint`、`replayFilteredEvents`；展示入口为 `packages/happy-app/sources/components/usage/UsagePanel.tsx`，采集范围由 `packages/happy-cli/src/daemon/run.ts` 合并。

## 优化方案

1. **先补齐真实漏记与澄清展示**：支持 `token_usage_record`，纳入独立压缩回执并做跨格式去重；标明“本机全部 Codex 活动”，机器、账号和 provider 的筛选范围显式展示。订阅 quota 单独标注账号。详情同时显示非缓存输入、缓存读取、输出、含缓存总处理量，提供精确值和自适应万/亿单位。
2. **建立可解释请求账本**：记录原生 session/parent、request/response ID、账号归属证据、模型、时间、原生/网关来源和原始计数字段。主会话、子任务、请求数分别统计；可下钻查看总量来源。
3. **修复去重边界**：同一逻辑 session 的副本去重，独立 session 不互相吞计数；历史导入使用已有显式边界。参考 Magpie 的 Total+Last checkpoint 以及自身 turn 边界识别 fork，移除无证据的一秒 burst 删除。
4. **提供对账和质量信息**：累计与 last 交叉校验；报告重置、缺失、回执修订、扫描范围与警告。区分“未读到”和“零用量”。保留用户触发的单次重扫，增量更新由原生事件/文件变化驱动，避免为对账引入周期全量扫描。
5. **将消耗优化建立在明细上**：按任务/模型展示非缓存输入、缓存命中率和重复上下文。长任务按阶段总结并限定工具输出、只读相关技能与文件；减少冗余上下文，同时保留有价值的稳定缓存前缀。token 与费用、订阅额度继续分开。

## Magpie 一手源码

本机固定提交：

- [主 tokens 排除缓存](https://github.com/yetone/magpie/blob/90efddabae4e1ac9bb97ab9beb9f5296133caba1/internal/usage/usage.go#L671)
- [Codex 输入归一化：减去缓存](https://github.com/yetone/magpie/blob/90efddabae4e1ac9bb97ab9beb9f5296133caba1/internal/sessions/codex.go#L84)
- [目录发现范围](https://github.com/yetone/magpie/blob/90efddabae4e1ac9bb97ab9beb9f5296133caba1/internal/appdir/codex.go#L31)
- [fork checkpoint 过滤](https://github.com/yetone/magpie/blob/90efddabae4e1ac9bb97ab9beb9f5296133caba1/internal/sessions/codex_fork.go#L14)
- [网关和本地来源分别展示](https://github.com/yetone/magpie/blob/90efddabae4e1ac9bb97ab9beb9f5296133caba1/internal/cli/usage_cli.go#L142)

最新 main 的后续参考（不代表本机已具备）：

- [按 response ID 合并用量回执及 compaction](https://github.com/yetone/magpie/blob/189ce66d7be943356334bdc63192c4e4482c1270/internal/sessions/codex_usage.go#L395)
- [网关与本地来源匹配去重](https://github.com/yetone/magpie/blob/189ce66d7be943356334bdc63192c4e4482c1270/internal/usage/direct.go#L35)

本轮只借鉴方案，没有复制或分发第三方代码。Magpie 仓库许可为 MIT。
