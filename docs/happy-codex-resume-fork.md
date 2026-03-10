# Happy Codex Resume Fork

## 概述

这个 fork 用来承载 `Happy Codex` 的会话恢复能力增强，目标是让已经关闭的 Happy Codex 会话可以在重新拉起后，尽量保留原来的对话记忆和上下文，而不是只恢复一个空壳会话。

当前 fork 信息：

- Fork 仓库：`https://github.com/KevinCJM/happy`
- 工作分支：`codex/happy-codex-resume`
- 变更提交：`c81bbf1c80ef4b007b144c80c3438be5aa1c2a1e`

建议用途：

- 作为你自己的可维护分支继续迭代
- 作为向上游发 PR 的基础
- 作为给其他人复现 Happy Codex resume 方案的参考实现

## 这个 fork 解决了什么问题

原始问题主要有三类：

1. Happy 会话恢复后在线，但 App 发消息没有响应
2. 恢复后没有原来的对话记忆和上下文
3. 需要手工拼环境变量和日志参数，恢复流程不稳定

这个 fork 解决后的行为是：

- 恢复时复用旧 Happy 会话加密 key
- 恢复时读取并保存 Codex session/conversation 标识
- 恢复路径优先走 Codex 原生 `app-server` 的 `thread/resume`
- 如果旧 thread 不可直接继续，则回退到本地 transcript 恢复
- 提供正式命令：`happy codex resume`

## 核心变更

### 1. 新增 CLI 命令

新增命令：

```bash
happy codex resume <session-id> --metadata-file <metadata.json>
```

也支持：

```bash
happy codex resume <session-id> --path <workdir> --pid <hostPid>
```

命令职责：

- 从 metadata 和本地日志解析恢复参数
- 自动定位 `sessionTag`
- 自动检查本地恢复快照
- 自动停掉同一 Happy 会话的旧进程
- 自动拉起恢复后的 Happy Codex 进程

实现入口：

- `packages/happy-cli/src/index.ts`

### 2. 修复恢复时的加密 key 复用

恢复模式下，如果 Happy 会话重新生成新的 `dataKey`，App 端已有消息就会解密失败，表现为在线但没回复。

当前实现改为：

- 读取 `~/.happy-session-crypto/session-<sessionId>.json`
- 或 `~/.happy-session-crypto/tag-<sessionTag>.json`
- 如果找到旧 `dataKey`，直接复用

这样恢复后的进程与原 Happy 会话仍然使用同一把会话 key。

实现位置：

- `packages/happy-cli/src/api/api.ts`

### 3. 增加 Happy 会话快照

当前分支会把以下内容持久化到本地快照：

- `sessionId`
- `sessionTag`
- `encryptionVariant`
- `encryptionKeyBase64`
- `codexSessionId`
- `codexConversationId`

作用：

- 下次恢复时不用只靠旧日志
- 能直接找到原会话对应的 Codex 标识
- 允许在 Happy 服务端不可达时回退到本地快照恢复

实现位置：

- `packages/happy-cli/src/codex/runCodex.ts`

### 4. 恢复时优先走 Codex 原生 app-server

普通新会话仍然走现有 MCP 路径。  
恢复场景则切到新的原生恢复客户端，直接调用：

- `thread/resume`
- `turn/start`
- `turn/interrupt`

这是当前恢复原上下文最关键的改动。

实现位置：

- `packages/happy-cli/src/codex/codexAppServerClient.ts`
- `packages/happy-cli/src/codex/runCodex.ts`

### 5. 旧 thread 无法继续时的回退策略

如果旧 Codex thread 不能直接续接，这个 fork 不会直接失败，而是：

1. 从本地 `~/.codex/sessions` 查找 rollout 文件
2. 提取最近的用户/助手对话
3. 把 transcript 作为恢复上下文注入新 session
4. 同时继续使用 `experimental_resume`

这一步不能保证“云端原 thread 原样复活”，但能最大化保留本地已有记忆和工作上下文。

实现位置：

- `packages/happy-cli/src/codex/runCodex.ts`

## 变更文件

本 fork 当前主要改动文件：

- `packages/happy-cli/src/index.ts`
- `packages/happy-cli/src/api/api.ts`
- `packages/happy-cli/src/codex/runCodex.ts`
- `packages/happy-cli/src/codex/codexMcpClient.ts`
- `packages/happy-cli/src/codex/codexAppServerClient.ts`

## 如何获取这个 fork

如果是在另一台机器上复现：

```bash
git clone https://github.com/KevinCJM/happy.git
cd happy
git checkout codex/happy-codex-resume
```

如果已经有上游仓库本地副本：

```bash
git remote add fork https://github.com/KevinCJM/happy.git
git fetch fork
git switch -c codex/happy-codex-resume --track fork/codex/happy-codex-resume
```

## 如何构建

在仓库根目录执行：

```bash
npx --yes yarn@1.22.22 install
npx --yes yarn@1.22.22 workspace happy-coder build
```

## 如何验证

### 验证命令是否接入

```bash
cd packages/happy-cli
node ./dist/index.mjs codex resume --help
```

### 验证恢复逻辑

前提：

- 目标 Happy session 的本地快照仍在
- 对应的本地 Codex rollout 文件仍在
- 当前机器仍是原机器

示例：

```bash
happy codex resume <happy-session-id> --metadata-file ./metadata.json
```

重点观察：

- 进程是否成功启动
- App 端是否能正常发消息
- 恢复后的回答是否带有原来的记忆上下文

## 向上游发 PR

当前 fork 分支已经可以直接用于 PR。

PR 创建入口：

- `https://github.com/KevinCJM/happy/pull/new/codex/happy-codex-resume`

如果你要提交到上游 `slopus/happy`，建议 PR 标题可以用：

```text
Add Happy Codex resume workflow
```

建议 PR 描述至少包含：

- 新增 `happy codex resume`
- 恢复时复用会话加密 key
- 保存并恢复 Codex session identifiers
- restore 场景优先使用原生 `app-server thread/resume`
- fallback 到本地 transcript/context 恢复

## 当前限制

这个 fork 的目标是“恢复之前的对话记忆和上下文”，不是保证“服务端原 thread 永久可续接”。

需要明确两点：

1. 旧 Codex thread 可能已经不可继续
2. 即使旧 thread 不可继续，本 fork 仍会尽量利用本地 transcript 恢复上下文

也就是说，这个方案优先保证“恢复体验”，不是强依赖旧服务端 thread 一定存在。

## 结论

这个 fork 已经把 Happy Codex 的恢复流程从“手工调试级别”推进到了“可命令化、可重复、可分享”的状态。

对外可以这样描述这个分支：

- 它增加了 `happy codex resume`
- 它能恢复 Happy 会话层加密上下文
- 它能尽量恢复原来的 Codex 对话记忆和工作上下文
- 它在旧 thread 失效时仍然有本地 transcript fallback
