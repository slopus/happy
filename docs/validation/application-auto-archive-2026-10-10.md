# 应用会话完成后自动归档

基线：`ca314cb7c71c6ffdba514a0d5ced3963ce8e1ea1`。分支：`fix/app-auto-archive`。

## 问题和行为

原应用侧栏把 completed 会话放进“会话历史”，但共享归档判断仍仅识别
`metadata.lifecycleState`。因此侧栏分组、全局归档页和操作按钮并不一致。

本次将成功完成的 application 会话纳入共享归档规则。使用已持久化的根 turn
结果恢复归档归属，不为每轮增加 metadata 写请求，也不停止后台热进程。
手动归档仍沿用原 lifecycle/停止路径；普通 Paws 会话不自动归档。

- 草稿、思考中、CLI 排队、待授权、本地排队/发送失败，以及已接受但尚未确认启动的
  followup 都保持在当前列表。失败、取消和缺失完成结果也不自动归档。
- 显式恢复写入加密 metadata 中的 `applicationArchiveRestoredThrough`，只豁免用户
  观察到的 completed turn。刷新仍保留恢复结果；下一轮完成后再次归档。
- 自动归档的热会话可直接接受追问。消息发送门禁只识别手动 lifecycle 归档。
- completed 先到、ready 后到时，ready 清除 thinking 后立即更新归档投影。
- 本地待发集合从 staging messages 和 barriers 投影；服务端分页/刷新不覆盖该集合。
  原 staging 持久化和账号隔离保持不变。
- 移除应用侧栏原有的每 10 秒授权/旧会话目录轮询（每次 2 个 GET）。目录仅在面板打开、
  回到前台、手动刷新、分页或本地授权修改后加载；原生会话状态继续使用现有推送。
  页面空闲不再为这个目录产生周期请求。旧版目录没有变更推送，跨设备修改需要上述刷新时机。

## 验证

66 个相关测试通过（原有 64 个，加上轮询移除的 2 个回归测试），App typecheck、`git diff --check` 通过。

| 文件 | 测试数 | 覆盖 |
| --- | ---: | --- |
| `sources/utils/sessionLifecycle.test.ts` | 10 | 自动/手动归档、普通会话、未完成状态、精确 turn 恢复 |
| `sources/sync/storage.lifecycle.test.ts` | 11 | 列表投影、草稿、刷新、ready 乱序、本地待发与延迟加载 |
| `sources/sync/ops.sessionMetadata.test.ts` | 3 | metadata 加密更新、版本冲突后保留恢复标记与并发字段 |
| `sources/components/AppConversationsSidebar.test.tsx` | 3 | 应用当前/历史分组；空闲 60 秒无额外请求；前台/手动刷新、在途合并、监听清理 |
| `sources/sync/messageStagingQueue.test.ts` | 17 | 排队、重试、barrier 与发送互斥 |
| `sources/sync/messageStagingQueueRuntime.test.ts` | 4 | 热会话追问、接受但未启动、离线/失败、手动归档发送门禁 |
| `sources/sync/storage.sessionSorting.test.ts` | 2 | 共享列表排序回归 |
| `sources/auth/AuthContext.logout.test.tsx` | 9 | 退出与切换账号回归 |
| `sources/utils/otaRuntimeConfig.test.ts` | 7 | OTA runtime 契约 |

复跑入口（在 `packages/happy-app` 下）：

```sh
pnpm exec vitest run sources/utils/sessionLifecycle.test.ts sources/sync/storage.lifecycle.test.ts sources/sync/ops.sessionMetadata.test.ts sources/components/AppConversationsSidebar.test.tsx sources/sync/messageStagingQueue.test.ts sources/sync/messageStagingQueueRuntime.test.ts sources/sync/storage.sessionSorting.test.ts sources/auth/AuthContext.logout.test.tsx sources/utils/otaRuntimeConfig.test.ts
pnpm typecheck
```

独立代码复审：PASS。复审发现的 ready 乱序 P2 已修复并增加回归测试；本地 staging
边界也已补齐。交互验收未执行，不以单测或代码审查代称浏览器通过。

## 尚未验证 / 发布状态

- 截图：已询问待回复；按仓库规则未采集，不将未回复视为同意或截图合并门禁。
- Ego 浏览器 E2E、原生真机验收和视频：未执行。
- 建议最小实测：应用回答完成后显示归档/恢复操作；显式恢复后刷新仍在当前列表；
  热追问无需重建会话且完成后再次归档；离线排队保留可见重试入口。
- 本报告生成时未合并、未上线。CLI、服务器和 SDK 没有改动或重新部署。
- 这是客户端共同使用的归档归属规则，并非对服务器批量写入 lifecycleState；旧版客户端
  仍使用旧规则，需要更新 App/Web 才能显示一致的归档行为。
