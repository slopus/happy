# Happy Agent 规范

## 适用范围

packages/happy-agent 是可发布的 Node.js CLI/库，只远程控制已经运行的 Happy 机器与会话；它不启动 Claude、Codex 等 agent runtime。入口是 src/index.ts，公开库产物由 pkgroll 生成。

## 核心边界

- 命令解析和人类/JSON 输出归 src/index.ts 与 src/output.ts。
- HTTP、Socket.IO 与服务端 payload 归 src/api.ts。
- 会话 ID 前缀解析、等待空闲和消息辅助归 src/session.ts。
- 机器 RPC 归 src/machineRpc.ts。
- 密钥落盘归 src/credentials.ts，加解密归 src/encryption.ts，二维码登录归 src/auth.ts。
- 共享消息结构从 @slopus/happy-wire 导入，不在本包复制 schema。

详细规则见 architecture-and-security.md 与 quality.md。
