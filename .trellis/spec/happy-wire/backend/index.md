# Happy Wire 共享协议规范

## 适用范围

packages/happy-wire 是可发布的共享 TypeScript/Zod 合同库，供 App、CLI、Agent 与 Server 同时消费。目录放在 backend 层仅用于 Trellis 分组；它不是服务端私有代码。

## 文件所有权

- src/messages.ts：加密消息容器、核心 update body 与兼容 alias。
- src/legacyProtocol.ts：仍需读取的 user/agent legacy 内容。
- src/sessionProtocol.ts：冻结、仍在评审的 session envelope。
- src/controlMessages.ts：控制类文本 wrapper 的安全解析。
- src/voice.ts：语音协议。
- src/rigMetadata.ts：Rig 元数据。
- src/messageMeta.ts：消息元信息。
- src/index.ts：唯一公开 export 面。

修改协议先读 protocol-guidelines.md，构建与发布读 quality-and-release.md。
