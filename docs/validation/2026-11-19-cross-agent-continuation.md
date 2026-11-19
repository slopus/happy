# 新建跨 Agent 接续会话：实现与验证

## 范围与结果

用户确认保留原会话，在相同工作目录创建另一 Agent 的新会话，首版 Claude ↔ Codex；随后明确不需要截图，仅完成代码与功能验证。本次没有安装/替换正在运行的 CLI，没有推送、发布 OTA 或上线 Web，也没有操作浏览器或真实用户会话。

会话菜单与详情页新增相反 Agent 的入口，目标保留 parentSessionId 和来源 Agent。只有在线且声明 conversion capability=1 的机器、已具备原生 ID 的非应用会话才能显示；执行中、待批准或有排队消息时不提供操作。目标以自身账号、系统指令与权限配置启动。

来源由 daemon 通过精确 /v2/sessions/:id 快照验证，前端不能传任意源路径或原始历史。导出前后重新检查来源 revision/native ID/cwd 与运行状态；不会停止、删除或改写源会话，但用户之后仍可能主动同时启动两边，因此界面提示避免两个会话同时执行。

## 历史保留与边界

- Claude 读取主 parent 链；Codex 使用原生 thread/read，绑定账号走既有隔离历史缓存。新建目标都不修改源日志。
- 用户/助手正文、Shell 调用与输出、用户内嵌或可恢复的本机图片迁移；未知工具转文本，私有推理不迁移。
- 工具输出逐条限制为 64 Ki 字符并显式标注截断；总转换限 32 MiB、最多 50,000 项；缺图片、历史链不完整、未知内容或正在执行的调用明确失败。
- Codex 的 inject_items 实测会把 input_image 持久化成文本，不能作为可恢复图片的导入方法。最终实现新建 legacy rollout，写原生 response_item、图片与已闭合 synthetic turn；临时文件完成并同步后才暴露为正式文件。
- 本机 cross-agent-context 保存可移植前缀及 synthetic turn ID；再次导出时剔除对应原生 synthetic turn，再拼入原始前缀，避免丢失或重复。完整 native fork 复制前缀，跨目录 fork 更新目录；缺失必要前缀明确失败。
- 导入部分为一个完整 synthetic turn，首版拒绝在该回合内部截断分叉，避免把 rewind 删除的上下文重新带回。导入后的新回合和完整分叉继续可用。
- 同 requestId 并发合并，持久收据防断线重试重复启动。确认没有 dispatch 的失败可重试；未知结果不盲目重启，可通过目标 metadata 的 request ID 找回已创建会话。跨 Agent 环境标记在 runner 捕获后清除，避免后续子进程继承身份。

## 初版验证（81b28ada；后续修复见文末）

| 检查 | 最终结果 |
|---|---|
| App 全量 Vitest | 554 文件、4,922 项通过 |
| CLI 全量 unit | 194 文件、1,857 项通过，2 项跳过 |
| App / CLI tsc --noEmit | 均通过 |
| 新增/相关 daemon、转换、重试测试 | 38 项通过；包括真实 daemon regular 已 dispatch 后超时与明确启动前失败 |
| 独立代码评审 | 首轮提出启动失败重试、原生 fork 前缀、旧会话快照问题，修复后通过；另修复目录更新及 synthetic rewind 边界 |
| 独立原生往返探针 | 通过文字、Shell 和精确 PNG 保留；未调用模型、未执行历史工具 |
| 最终 native probe | Claude 写入→Codex 原生 resume→原生历史可见性→导出→Claude 重建通过 |
| 截图 / 浏览器 / 手机验收 | 用户本次不需截图；未执行浏览器或真机交互 |
| 真实模型续聊 / 在线发布 | 未执行；代码与原生格式验证不等于线上已可用 |

CLI 首次全量运行继承当前 Happy 会话的 Codex 账号环境，导致本应模拟未绑定客户端的测试失败；移除测试子进程中的 HAPPY_CODEX_ACCOUNT_PROFILE_ID、HAPPY_CODEX_ACCOUNT_CREDENTIAL_VERSION、CODEX_HOME、HAPPY_CODEX_PATH 后相关客户端测试通过。Goal Board fs.watch 测试在中间两次运行有超时，最终隔离环境的全量运行全部通过。没有为这些现象修改账号或 Goal Board 产品代码。

## 复跑入口

在本 worktree 先 pnpm install，构建 happy-wire 与 paws-agent，再执行：

```sh
pnpm --filter happy-app exec vitest run --maxWorkers=4
env -u HAPPY_CODEX_ACCOUNT_PROFILE_ID -u HAPPY_CODEX_ACCOUNT_CREDENTIAL_VERSION -u CODEX_HOME -u HAPPY_CODEX_PATH pnpm --filter @wangjs-jacky/paws exec vitest run --project unit --maxWorkers=4
pnpm --filter happy-app typecheck
pnpm --filter @wangjs-jacky/paws typecheck
HAPPY_CODEX_PATH=<真实 Codex 二进制绝对路径> pnpm --filter @wangjs-jacky/paws exec tsx scripts/probe-cross-agent-history.ts
```

探针使用隔离临时 home 和合成资料，清理自己的临时文件，不调用模型、不触碰用户项目。真实模型接续、完整 Happy UI 新建链路、手机和已发布 CLI 仍需配套执行端部署后验收；旧 CLI 不声明新 capability，入口不会提前出现。

## Code review 后续修复（2026-11-19）

初版提交 `81b28ada` 之后的三项 review 问题已处理：

1. **聊天内 /fork**：前缀复制移至所有入口共用的 `CodexAppServerClient.forkThread`，成功复制后才切换本机 thread ID，失败清理目标。`/clear` 同时清除继承上下文标记，避免新空白线程错误要求旧前缀。原生探针新增“直接原生 fork → 导出”检查。
2. **启动结果恢复**：request ID 同时匹配活跃会话与 finished map；daemon 启动从持久记录加载的会话也参与恢复。增加 worker 退出和 daemon 重启后的幂等回归，均不创建第二个执行端。
3. **Claude 无输出推理**：`Session` 在 thinking 变化时向加密 agentState 写入 `claudeThinking`，不依赖首次回复产生的协议回合；持续输入流的后续消息也重新标记忙碌。两次来源核对比较 agentStateVersion，以发现正文 seq 未变化但执行状态已变化的情况。

Relay active 不能证明本机进程是否退出。后端在显式转换请求中做单次 PID 信号0探针，只把 ESRCH 视作“已退出”；权限错误、未知 PID 和仍存活进程不会清除忙碌判断。在线而缺少新字段的旧 Claude worker 保守拒绝转换。离线 App 不再因遗留 thinking/running 状态永久隐藏 Claude 入口，由后端核验本机进程；确认退出可忽略旧运行标记，待批准请求、排队消息及原生历史完整性检查仍保留。

验证边界：daemon 回归使用模拟进程/网络与真实临时回执文件；原生 Codex 探针使用真实二进制和合成资料。未请求模型、未操作用户会话、未安装或发布 CLI/Web/OTA。沿用用户本次不需要截图的决定。

已通过：54 项针对性 CLI 回归、App 全量 4,922 项、两端类型检查、独立静态复核，以及带 `/fork` 的文字/Shell/精确 PNG 原生往返探针。

CLI 全量并行运行曾有原生子进程与 fs.watch 超时；最终串行复核结果在下方补记。

最终串行 CLI unit：196 文件全部通过，1,866 项通过、2 项跳过；App 全量仍为 554 文件、4,922 项通过。两端 tsc 通过，git diff --check 通过。独立最终复核未发现剩余阻断问题。
