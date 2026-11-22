# Web 存储迁移清单

基线 8a90e4c372959e8078f5d393577905cb5f5957fb。此表记录实现映射，不声称已通过所有浏览器/设备验收。

| 写入入口 | 业务域/旧物理键 | Web 目标及完成契约 |
|---|---|---|
| sync/persistence.ts | mmkv.default 或 default-account-<scope> 下的设置、pending-settings、草稿、文件工作区、项目偏好、评注、大文本等 | IDB records；同步水合读、观察到的异步写；全局保存中/失败/导出入口；关键操作另行 flush |
| sync/composeDraft.ts | compose-draft[-account-<scope>] 下 text/discussing | IDB；图片选择依旧内存态，不把 blob URL 称为持久附件 |
| sync/messageStagingQueuePersistence.ts | message-staging-index 与 message-staging-<tab>[-account-<scope>] | IDB；原 namespace/生命周期 Web Lock 不变；save Promise 在事务完成后返回 |
| sync/firstSubmissionRuntime.ts | first-submission-v1:<serverOrigin\|accountId> | 迁为 first-submission-v1\<scope>；提交并确认后才 spawn/send；当前 scope 退出精确清理 |
| sync/publicSessionShareQueuePersistence.ts | public-session-share-queue[-account-<scope>]\jobs-v1 | IDB；入队和执行前 flush，新版标签页生命周期所有权锁；未知运行结果不自动重发 |
| sync/sessionContinuation.ts、crossAgentContinuation.ts | session-continuations、cross-agent-continuations 的账号 namespace | IDB；创建远端会话前 await 恢复凭据提交 |
| components/annotations/annotationRuntime.ts | primary namespace/message-annotation-v1:* | IDB；保留原接口和恢复原文，保存状态通过全局面板显示 |
| sync/sessionWarmCache.ts | session-warm-cache[-account-<scope>]\encrypted-wire-v1 | IDB 可重建缓存；失败不阻断关键提交；已导入旧缓存可清理 |
| sync/sessionHistoryPageCache.ts | session-history-pages-v1[-account-<scope>] | IDB 可重建缓存；不替代既有 Web localHistoryStore |
| changelog/storage.ts、hooks/useChangelog.ts、utils/requestReview.ts | primary namespace 的已读标志/计数 | IDB；普通偏好，不成为消息发送先决条件 |
| auth/accountIndex.web.ts、tokenStorage.ts | paws.accounts.*、认证凭据 | 有意保留现有 localStorage 架构，不导入新库、不进入恢复导出；账号切换先 flush 业务写入 |
| sync/serverConfig.ts | server-config 下服务地址 | 有意保留小型 localStorage 白名单；不在此改认证/服务切换架构 |
| scripts/injectWebLoading.ts | 首屏主题读取 | 启动 HTML 保留旧主题只读回退；真正主题在入口水合后读取 IDB，不写回大型旧 local-settings |
| hooks/usePublicSessionAppearance.ts、通知/声音 claims | 分享页外观、通知去重 | 有界小型 localStorage 记录，保留原有失败保护；不导入私人业务库 |
| sync/localHistoryStore.ts、stagedAttachmentStorage.web.ts、relationshipAdvisorImageCache.web.ts | 已有历史/附件 IDB 库 | 继续原库，不重复导入；当前账号 staging 清理从新库权威枚举 namespace，避免缓存 index 漏清 |

实现选择：第一版保留原物理 namespace 与业务 map 的粒度，防止在迁移时同时改变账号身份和所有消费者的数据结构。记录级 CAS 保护整个 map；冲突保留原文并提示恢复，不做静默 last-write-wins。后续按会话拆小记录是性能优化，不能拿它作为本轮完整性前提。

迁移只认上述业务 namespace。未知键不删除；关键旧源默认保留。显式退出/清理才移除对应源和恢复正文，并保留无正文撤销标记防复活。账号级 epoch 阻止其他旧 runtime 新建 namespace 后继续写入；first-submission 以完整 scope 精确清理，不连带删除其他账号。
