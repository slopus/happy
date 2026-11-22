# Codex 默认模型、强度与主动选择验收

## 修复契约

- 没有用户选择意图的旧 Codex 草稿跟随当前默认模型和强度，保留正文、设备、目录及附件。
- 新建页主动选择保存逐字段的默认值快照；刷新保留，只有对应默认值改变时失效。默认 A→B→A 不恢复旧选择。
- 初始化目录和强度展示不写入用户意图；发送复用同一解析结果。从已有会话切换 Agent 后新建的入口也遵守此契约。
- Codex 强度 fallback 支持 Ultra，权威的当前模型目录仍优先。

## 已确认原因

1. 旧草稿仅有值，没有选择来源，初始化 effect 还会将解析结果固化。
2. `AgentDefaultOverridesSchema.default({})` 会在解析空 pending delta 时生成 `agentDefaultOverrides: {}`；重启同步将其作为清空设置上传。默认值应仅由完整的 `settingsDefaults` 提供。
3. Sol/Luna fallback 最高只有 Max，归一化会将 Ultra 回退为 Medium。

## 自动验证

13 个直接相关测试文件共 235 项通过（含设置 partial delta、草稿持久化、默认变化、手选、目录水合、Agent 切换、发送元数据和 7 项 OTA runtime 契约）。新增 schema 回归在修复前失败、修复后通过。

```sh
cd packages/happy-app
pnpm exec vitest run sources/components/SessionConfigPanel.test.tsx sources/hooks/useSessionAgentComposer.web.test.tsx sources/utils/newSessionModeSelection.test.ts sources/hooks/useNewSessionDraft.test.ts sources/sync/persistence.retiredDraft.test.ts sources/sync/retiredSessions.test.ts sources/sync/settings.spec.ts sources/utils/newSessionSpawnSettings.test.ts sources/components/modelModeOptions.test.ts sources/utils/runningSessionTurnModes.test.ts sources/sync/messageMeta.test.ts sources/components/ComposeHome.test.tsx sources/utils/otaRuntimeConfig.test.ts
pnpm typecheck
```

Expo 启动曾生成空的路由类型；结束本地 Web 后用既有 `e2e/fixtures/goal-board/repair-router-types.mjs` 生成真实路由类型再执行完整类型检查。

## 真实验收范围

使用隔离分支的本地完整 Web，连接正式 relay 和 Mac mini 现有 CLI，以 Ego 操作设置和新建页。测试消息仅请求固定文字，不调用工具或修改文件。对照页面、首条消息元数据与原生 `thread_settings_updated.collaborationMode.settings`。

- 默认设为 Astra / Ultra，刷新设置和新建页仍保留；真实回复 `FINAL_ASTRA_ULTRA_OK`，执行端为 `gpt-6-astra` / `ultra`，会话完成。
- 默认 Astra / Ultra 不变，主动选择 Sol / High 后刷新；真实回复 `FINAL_SOL_HIGH_OK`，执行端为 `gpt-6.1-sol` / `high`，会话完成。
- 再次修改默认强度并设为 Sol / Ultra，旧的 High 不再覆盖；真实回复 `FINAL_SOL_ULTRA_OK`，执行端为 `gpt-6.1-sol` / `ultra`，会话完成。
- 测试后将 Codex 设置恢复为原来的代码默认值。

初始化在 Home 目录的一次试验在 `config/read` 阶段退出；改为既有仓库目录后完成真实推理。这是未修复的执行环境边界，不把该失败当作设置修复成功。

## 界面与边界

沿用设置列表、统一模型/强度选择器、当前语义主题 token，不新增布局或色值。现有输入、关闭、Escape 和刷新路径保持。

PR 前后对比截图已询问，未获回复，不作为合并门禁。Happy Skills 的关键浏览器步骤按会话要求独立回传，不在公开 PR 上传生产账号页面。没有请求视频。

未新增原生依赖、权限、包名或 runtime；共享 JS 的 OTA 按现有 CI 分类发布，无需重建 APK。Android 真机加载及旧原生线程已有 turn 后的 CLI effort 重置不属于本次新增验收。
