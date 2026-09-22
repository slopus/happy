# Changelog

## 0.2.0 - 2026-09-20

- feat(sdk): 创建会话时指定清单和 Tag (#611) (e8e77bfe)
- feat(agent-party): 群聊、Codex 配置与十轮自动辩论 (0d782153)
- fix(agent): wait for npm promotion metadata to converge (#587) (f70bfa80)
- fix(agent): verify published packages without republishing (#586) (c53fc211)
- chore(agent): release paws-agent v0.1.0 (be7a6d63)
- feat(paws-agent): add model configuration and execution lifecycle support (b5aba751)

## 0.1.0 - 2026-09-17

- 首个稳定版本，包含 beta.4 的可靠消息订阅、图片上传和 Codex 会话授权支持。
- 新增类型化的逐轮模型 / 思考强度配置和 runner 配置目录查询。
- 新增 `sessions.terminate()`：释放远端执行进程，保留历史与恢复信息。
- 修复 Cloudflare Workers 图片上传，明确报告附件准备失败时正文尚未提交。
- 记录启动就绪、进程释放与恢复的调用约定；未包含全局并发队列。

## 0.1.0-beta.4 - 2026-09-15

- fix(agent): 恢复未绑定账号时的本地 Codex 登录 (23627379)

## 0.1.0-beta.3 - 2026-09-15

- 新增 `messages.watch`：按序分页补齐批次与重连缺口、去重、取消，以及错误显式上报；重连补齐完成后才发出 ready。
- `history` 支持 `afterSeq` / `beforeSeq`，新增包含 `hasMore` 的 `historyPage`，保留默认最新消息行为。
- 支持解密并校验 `session-stream` 的累计 `text-delta` 预览；预览独立于持久消息和完成判定。
- 将 Chrome 插件 0.0.8 的 SDK 补丁回迁到 TypeScript 源码：Codex 启动前申请机器绑定的一次性授权，失败时不降级启动。
- `messages.send` 支持 PNG/JPEG/WebP 原始字节和 `AbortSignal`，复用 Happy Blobs 加密协议以及本地 PUT / 对象存储 POST 上传。
- 文件事件和正文按顺序一次提交；上传失败或取消时不发送残缺消息。仅图片也发送空正文以触发 CLI 处理。
- 严格校验上传描述符、阻止重定向和第三方 token 泄露，上传支持 15 秒超时及客户端销毁取消。

可靠订阅可补齐现有会话的持久消息；Codex 实时正文、结束顺序和重复输出修复需要配套 CLI 1.3.11。旧工作进程不支持热更新，升级后需启动新的工作进程。

Chrome 插件 0.0.8 的本地补丁仍需在插件升级 SDK 并完成集成验证后移除；发布 SDK 不会自动升级插件。

## 0.1.0-beta.2 - 2026-09-09

- Prepare the first public npm release, distributed on the `next` tag.
- Emit `syncing` and a reusable initial `snapshot` before the connection becomes ready.
- Fetch individual sessions through `/v2/sessions/:id`, including realtime updates, instead of repeatedly downloading the entire session list.
- Validate point-response identity and check fresh session activity before sending.
- Port the startup and session-lookup regression tests from paws-agent-chrome v0.0.5.

This is a beta SDK. Publication status must be checked against the npm registry; this changelog is not proof that a release has been published.
