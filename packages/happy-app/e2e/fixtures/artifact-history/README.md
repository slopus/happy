# 真实原生作品历史验收

这组夹具运行完整 Expo App、独立 PGlite 账号/服务器、当前分支实际 CLI daemon、实际 spawned Paws Codex worker 和原生 app-server。模型与文件编辑没有替身。只在隔离环境内生成合成 MD/图片/HTML/CSS/JS；会消耗已登录 Codex 账号的模型用量。

先按根 CLAUDE 在 sibling worktree 安装依赖并完成 CLI/wire 构建。不要在浏览器验收中重建 CLI：daemon 可能检测 bundle 变化并轮换，影响正在观察的环境。普通 Vitest 的 globalSetup 也会重建 CLI。

```sh
pnpm exec tsx --tsconfig packages/happy-cli/tsconfig.json packages/happy-app/e2e/fixtures/artifact-history/serve.mjs
```

`test-results/artifact-history/runtime.json` 记录本次唯一环境、节点路径、项目、会话、loopback controller。`auth-url.txt`、CLI home 与 codex-home 是私有测试资料，不打印、不上传、不纳入证据或提交。初始化只复制本机 Codex auth 到 0700/0600 的独立目录，不修改原账号。完整 App 的 dev-token 引导只在 dev 模式生效；完成登录后可只重启该环境 Web，以 `--no-dev --clear` 完整重载验收最终源码。

所有网页动作只允许经 ego-ops / ego-browser。复用本任务记录的数值 task-space、精确 target 与 runId；不要照搬别人的运行 ID。`replay.ego.mjs` 内的这些运行绑定是本机本轮验收值，新任务必须显式改为该任务记录的真实值，不能自动选择当前页。

`spawn-replay.mjs artifact-replay-<数字>` 通过真实加密 machine RPC 在新的合成 sibling 目录启动原生 worker；必须成功断言未继承父会话 Codex profile，才继续录像。将脚本交给 `ego-browser nodejs`，传入 Ego 的 context helpers。录像用新鲜 `Page.startScreencast` 数据和原始时间戳，模型完成由独立 Node 子进程订阅实际加密事件观察；不查询业务轮询。Ego 的 `process.execPath` 不保证是 Node，使用 runtime 明确记录的 nodeBinary。

`verify.mjs` 和 `verify.mjs replay` 从真实 daemon 读回历史，核对 V1、AI V2/V3、恢复 V4、AI V5、V4 与 V1 全部资源完全相等，及当前清单与磁盘一致。额外并发复验产生的 V6+ 保留并单列，不伪装成 V5。

`boundaries.mjs isolation` 用独立真实账号验证 REST 和加密 RPC 隔离，并验证 session RPC 的目录与符号链接越界。`gate.mjs prepare/during` 通过单个文件事件屏障保持真实 native tool 活跃，调用 `boundaries.mjs active` 确认写入期间恢复被拒；无模型替身或状态注入。

`lifecycle.mjs offline/online` 只操作 runtime 指向的独立 home/server，保留机器、账号、历史目录和会话。初始化和重启都清除父进程 `HAPPY_CODEX_ACCOUNT_*`、`HAPPY_CODEX_SESSION_*`，否则可能触发正确的跨账号恢复保护，不能将这种测试配置错误记为产品发送失败。

收尾前保存脱敏读回结果、报告和通过版本 MP4，报告最后浏览器状态并独立 finish；再停止额外 replay 会话与本 fixture 记录的会话、独立 daemon、Web 和 server。不要停止生产 daemon 或用户已有会话，不把隔离历史重置当作持久化验收。`serve.mjs` 的 SIGINT/SIGTERM 清理仅涵盖该独立环境；旧进程若早于 extra-session 跟踪代码启动，先按返回的真实 ID 显式停止额外会话。
