# 架构、协议与安全

## 命令组织

src/index.ts 使用 Commander 声明 auth、list、machines、spawn、status、create、send、history、stop 和 wait。新命令保持三段式：

1. Commander 层只做参数声明、输入校验和退出码映射。
2. API/session/machineRpc 模块完成网络和领域行为。
3. output 模块负责 human 与 --json 两种稳定展示。

不要把复杂网络循环写进 action 回调，也不要让 output 模块发请求。

## 认证与密钥

凭据默认位于 HAPPY_HOME_DIR 下的 agent.key，读写集中在 src/credentials.ts。文件权限、原子写入和登出清理由该模块保持一致。src/auth.ts 实现二维码挑战应答；不要在日志、错误或 JSON 输出中打印 secret key、token、签名原文。

src/encryption.ts 同时处理当前 AES-256-GCM 记录和已有 NaCl secretbox 记录。加密输入输出必须经过明确编码和长度校验；不得用静默 fallback 把解密失败当明文。

## 协议边界

- src/api.ts 对 REST 与 Socket.IO 响应做结构检查，并只向上返回领域数据。
- src/session.ts 的 prefix matching 必须拒绝零匹配与多匹配，不能随意选第一条。
- src/machineRpc.ts 只向 machine-scoped RPC 发送已定义方法。
- 消息和会话 wire 类型来自 packages/happy-wire；新字段先在共享 Zod schema 定义并测试。

真实例子：

- src/session.test.ts 覆盖 ID 前缀与状态等待。
- src/encryption.test.ts 覆盖当前和 legacy 解密。
- src/api.test.ts 覆盖请求、认证 header 与失败映射。
- src/auth.test.ts 覆盖登录轮询和取消。

## 反例

- 在命令 handler 中直接拼 Authorization header。
- 以 console.log 输出对象并声称支持 --json。
- 把 token 放入 thrown Error。
- 在 happy-agent 中增加本地 agent 进程管理；那属于 happy-cli。
