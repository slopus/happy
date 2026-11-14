# 会话底部跟随、历史选择卡片与工具诊断回归

本次覆盖 PC Web 的会话切换和持续输出，以及共享 Markdown 选择卡片、Codex 工具事件与历史工具呈现。基线为 main 的 `28c6aa64`；后端加密 metadata 的传输契约不变。

| 用户问题 | 验收结果 | 对应 Case |
| --- | --- | --- |
| 切换后仍需下滚、内容反复跳动 | 初始只挂载尾部一批，取消 vendor 的估算索引跳转，按实际 DOM 高度同步定位；四次切换的 44 次布局后采样离底均为 0px | SWITCH-FRAMES、SWITCH-LATEST |
| 回看选择卡片还能再次提交 | 回答与跳过保存为加密 metadata 回执；切换、刷新后只读，保留原选择；没有回执的旧卡片也能根据后续用户回复关闭 | ANSWER-PERSISTENCE、SKIP-PERSISTENCE、LEGACY-ANSWER |
| Skill/工具报错不清楚 | 只有纯 Skill 文档读取才归类为 Skill；混合命令保留终端身份；真实失败保留并优先呈现 stderr 等具体原因 | TOOL-DIAGNOSTIC，wire 与 mapper 单测 |
| 回复时不自动跟到底 | 同一流式 item 连续增高五次，离底均为 0px；用户上翻后停止跟随，主动回到最新时恢复 | STREAM-FOLLOW、READING-PAUSE、USER-READING |
| 兼容已有阅读恢复 | 同会话详情页返回保留原阅读行及相对位置，刷新定位最新 | DETAIL-RETURN、RELOAD-LATEST |

选择回执以 wire ID、block key 和 Markdown block 序号定位，不依赖重放时变化的 reducer ID。并发写入保留已有回执及其他 metadata；账户、加密 owner 和历史 fence 改变后拒绝迟到写入。发送已经进入 durable outbox 后，单独保存回执失败不会重新开放重复发送；跳过则等保存成功再锁定。

Web 继续使用单个 scroll coordinator。真实 DOM 高度、React commit 和 ResizeObserver 驱动跟随；显式“最新”意图绑定当前 owner，用户阅读、owner 更换和卸载会撤销。默认历史恢复仍等待持久阅读状态与真实布局。未新增业务状态轮询。

验证通过：App 11 文件 241 项、wire 36 项、CLI mapper 72 项，共 349 项；另完整 App 536 文件 4722 项通过。没有诊断详情的失败 Skill 保留原有无详情状态，不虚构错误摘要。App、CLI 与 wire 类型检查/构建通过；独立代码评审通过。没有把所有模型或第三方工具的真实错误宣称为已消除。

## 复跑

使用已有完整 App / 隔离 PGlite fixture，不连接生产账户，不启动 daemon，也不调用外部模型：

```sh
pnpm exec tsx --tsconfig packages/happy-cli/tsconfig.json packages/happy-app/e2e/fixtures/codex-settings/serve.mjs
pnpm exec tsx --tsconfig packages/happy-cli/tsconfig.json packages/happy-app/e2e/fixtures/codex-settings/seed-scroll-switch.mjs
pnpm exec tsx --tsconfig packages/happy-cli/tsconfig.json packages/happy-app/e2e/fixtures/codex-settings/seed-chat-regressions.mjs
```

按 fixture README 用私有认证入口登录 Ego，随后导航到 clean URL。记录数值 task space 与精确 target；加载 `verify-chat-regressions.ego.mjs` 的 `verifyChatRegressions({ page, runtime, seed, controller })`。再运行 `verify-scroll-switch.ego.mjs` 的原四项回归；若复用已经追加内容的会话，更新合成 A 的 `latest` 为当前已知尾部标记。

七项新 Case 与四项已有 Case 均在同一套完整 App 中通过，并完成录制复跑。底部采样保留 rAF 内的 `beforeLayout` 诊断，再检查布局/ResizeObserver 阶段后的距离，避免把同轮绘制前已修正的临时尺寸当成可见跳动。详情返回前等待真实阅读回执与当前 DOM 锚点一致，不用固定延时猜测持久化完成。

录像由同一 Ego 目标页连续采集生成，编码 H.264/yuv420p、1440×1000、30fps；重复帧编码不代表原生高帧率采集。最终 MP4 完整解码通过；浏览器关键步骤通过绑定当前 Happy session/run 的截图 helper 上报。没有采集未获确认的 PR Before/After 对比。

回执、逐布局数据、原始录制帧及 MP4 位于被忽略的 `artifacts/chat-regressions-20261114/`。依次 POST 各 seed controller 的 `/shutdown`，最后关闭主 fixture，可清理本轮临时服务和环境；不会清理验收产物。
