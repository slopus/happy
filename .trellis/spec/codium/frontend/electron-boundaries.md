# Electron、IPC 与 Worker 边界

## 三个信任区

main 进程拥有窗口、文件系统、SQLite、PTY、进程和凭据。renderer 只负责 UI，不能直接 import node:fs、child_process、better-sqlite3 或 agent SDK。preload 使用 contextBridge 暴露最小、类型化 API。

electron.vite.config.ts 分别声明 main、preload、renderer 入口。新增跨边界能力时：

1. 在 main 注册一个窄 IPC handler。
2. 在 preload 暴露语义化方法，而不是通用 invoke(channel, payload)。
3. 在 preload/index.d.ts 更新 renderer 类型。
4. 校验路径、workspace、URL 和用户输入。
5. 添加 main 或 preload 合同测试。

## Agent Worker

sources/boot/main/agent-worker/host.ts 管理 worker 生命周期，worker.ts 在隔离进程内加载 Codex/Claude runtime，codex-cli.ts 管理 CLI 调用。renderer 通过 sources/agents/agent-bridge.ts 的 AgentSession 接收事件，不直接持有 child process。

启动、发送、停止与退出都要保持单一 session ID，并在窗口关闭或进程崩溃时清理 listener 和 child。不要把 SDK token、完整环境或原始 stdout 写入 renderer 日志。

## Happy Worker 与终端

sources/boot/main/happy-worker 为 Happy 连接提供独立 worker。终端 UI 位于 app/components/terminal，PTY 所有权仍在 main。跨 IPC 的事件必须可序列化，并且取消订阅函数在组件 unmount 时调用。

## 安全反例

- renderer 中启用 nodeIntegration。
- preload 暴露任意文件读取或 shell 命令。
- 用字符串拼接 shell 命令处理 workspace 路径。
- 忽略 worker exit，导致聊天永远停在 streaming。
