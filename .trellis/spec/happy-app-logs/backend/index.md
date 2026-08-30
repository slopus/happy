# Happy App Logs 规范

## 适用范围

packages/happy-app-logs 是单文件、本地开发用 HTTP 日志接收器。src/server.ts 在 0.0.0.0:8787 接收 POST /logs，将格式化行写入 HAPPY_HOME_DIR/app-logs 并输出到 stdout。

## 变更规则

- 保持零运行时依赖，优先使用 node:http、node:fs、node:path 与 node:os。
- HAPPY_HOME_DIR 的 ~ 展开语义与 happy-cli/src/configuration.ts 一致。
- 只接受 OPTIONS 与 POST /logs，其他路径返回 JSON 404。
- 文件流在进程级复用，不为每条日志重新打开文件。
- 输入是外部不可信 JSON；读取大小、字段类型和错误响应的改动必须有明确边界。
- 此接收器当前没有认证，且监听所有网卡，只应用于受信开发网络。

## 敏感信息

message 会被原样写盘和打印，因此调用方必须先脱敏。不得把 Authorization、token、cookie、密钥、环境变量快照或完整请求 payload 发到此服务。若为本包增加统一脱敏，应复用 happy-cli 中同一套经过测试的规则或抽成共享模块，不能维护两份逐渐漂移的正则。

## 验证

本包目前没有 test/typecheck script。修改后至少执行：

    pnpm --filter happy-app-logs exec tsc --noEmit
    pnpm --filter happy-app-logs start

用 OPTIONS、合法 POST、非法 JSON、错误路径验证状态码，并确认输出写入临时 HAPPY_HOME_DIR，不污染真实 ~/.happy。
