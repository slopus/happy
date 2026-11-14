# 切换会话时显示最新消息

PC Web 切换到另一个会话及冷启动时，加载最新消息并定位底部。用户在当前会话主动向上阅读后，新输出继续保留阅读位置；进入详情页后返回同一会话也保留位置。

## 修复

- 入口请求在 Deferred 首次挂载后也会被消费，并排在会话滚动状态重置之后，避免丢失待完成的最新窗口跳转。
- 首次进入与跨会话切换向同步层传递 `initialPosition: latest`，冷缓存、尾窗口缓存和历史窗口缓存都优先加载尾部；迟到的后台验证不再重新应用进入前的旧阅读锚点。
- Route ownership 记住本轮打开的会话，成功后同会话详情重挂载使用恢复模式，失败重试仍保留首次最新意图。保留在弹层下的组件优先保留已有阅读状态。账号创建和恢复重置这份临时记忆。
- 原生平台继续使用现有历史恢复行为。没有新增轮询、固定延迟滚动或业务重试服务。

## 验证

343 项相关回归通过，包含首次请求、迟到阅读状态、异步最新页提交、三种缓存入口、同会话重挂载、透明弹层、重试及原生路径。完整 App 类型检查通过。两条入口组件回归在原实现上均失败。

```sh
pnpm --filter happy-app exec vitest run \
  sources/sync/sessionRouteOwnership.test.ts \
  sources/sync/sync.messageVisibility.test.ts \
  sources/components/ConversationTranscript.pagination.test.tsx \
  sources/components/transcriptReading.test.tsx \
  sources/-session/SessionView.hydration.test.tsx
pnpm --filter happy-app exec tsc --noEmit --incremental false
```

## 浏览器验收

运行入口见 [Codex settings fixture](../../packages/happy-app/e2e/fixtures/codex-settings/README.md)。使用完整 App、隔离 PGlite 账号及真实加密消息传输，合成两段长会话；无生产数据、daemon 或外部模型调用。

| Case | 通过标准 | 结果 |
| --- | --- | --- |
| SWITCH-LATEST | A 上翻后经侧栏切 B 再切 A，两次离底距离小于 30px，正文 wheel 计数未增加 | pass |
| USER-READING | 上翻后真实提交一条合成回复，正文数据更新，偏移变化小于 2px，继续停留在历史 | pass |
| DETAIL-RETURN | 详情页返回，恢复同一可见行及其相对视口位置，误差小于 2px | pass |
| RELOAD-LATEST | 保留旧阅读状态刷新，最新回复出现且离底小于 30px | pass |

普通与可视状态复跑使用同一个 Ego Case。逐状态视频只展示经过断言的状态，不代表连续录屏；手机原生交互与正式线上构建不在本轮验证范围。

前后对比截图已询问、待回复；按会话既有浏览器证据要求回传最终验证状态，未将其作为前后对比图。
