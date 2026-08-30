# 日志、安全与错误处理

## 中央日志

所有内部调试日志使用 src/ui/logger.ts 的 logger。它写入 HAPPY_HOME_DIR/logs，避免污染 agent 的交互 stdout。console 只用于明确的用户可见 UI 或必须遵循的子进程协议。

logger 在字符串和结构化参数进入文件前统一调用 redactSensitiveLogString/redactSensitiveLogValue。新增 logger 方法或新的 sink 必须复用同一脱敏入口，不能让调用方自行决定是否脱敏。

敏感键包括 authorization、token、secret、password、cookie、api key、private key 等。Bearer/JWT、URL query 凭据和 JSON 中的敏感值必须在嵌套对象、数组、Error.cause 中同样被替换。回归测试见 src/ui/logger.test.ts。

## 日志内容

- 大对象使用 logger.debugLargeJson 或明确截断。
- 记录稳定标识、状态和时长，不记录消息正文、完整请求 header、环境变量或密钥文件内容。
- 错误日志保留错误类型和安全上下文；不要把 token 拼进 Error.message。
- App-server、MCP 和 Socket 原始 payload 只在确认无敏感内容后记录摘要。

## 错误与清理

长生命周期操作使用 AbortController 或明确 shutdown promise。所有 spawn、socket、timer、临时服务和锁都要在正常退出、信号与异常路径清理。

连接错误由 src/utils/serverConnectionErrors.ts 分类和重连。用户可恢复错误输出可操作提示；内部堆栈写入已脱敏文件日志。不要吞掉会导致 session 状态不一致的错误，也不要把同一瞬时网络错误在 tight loop 中刷日志。

## 凭据边界

- access.key 和 auth token 只由 auth/persistence/API 层消费。
- 环境变量可选择 server URL 和 home 目录，但不应输出完整环境。
- MCP 子进程仅传递所需配置；不把全部 Codex/Claude 配置复制到日志。
- 测试凭据使用临时 HAPPY_HOME_DIR，不读取开发者真实 ~/.happy。
