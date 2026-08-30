# 安全、日志与错误

## 零知识边界

服务端保存和转发客户端密文，不能解密会话正文。HANDY_MASTER_SECRET 用于服务端 token/key 派生，不是用户内容密钥。认证由 sources/app/auth/auth.ts 与 enableAuthentication.ts 完成，账户通过公钥挑战建立。

新增端点必须先判断资源所有权，再读写 Session、Machine、Artifact、File 或 AccessKey。仅验证 bearer 存在不足以授权具体资源。

## 编码与秘密

新增协议编码使用 privacy-kit 的 encodeBase64/decodeBase64。不要把 token、secret、Authorization header、cookie、签名或密文正文放进日志。环境检查只报告变量是否存在，不回显值。

## 日志

统一使用 sources/utils/log.ts 的结构化 logger，并提供稳定 module、资源 ID、状态和时长。未经明确需求不要增加高频日志。presence、Socket 和重试路径尤其要避免每事件 info。

sources/app/api/utils/enableErrorHandlers.ts 的策略：

- 4xx 返回经过控制的客户端错误。
- 5xx 只返回通用消息。
- onError 记录服务端错误和 transaction timeout。
- 未匹配路由返回 method/path，但 self-host SPA 可跳过默认 404 handler。

新增错误分类保持这个边界，不在 response 泄漏 stack、SQL 或内部路径。

## 外部集成

GitHub、ElevenLabs、Push 和对象存储密钥只在对应 module/app 层读取。GitHub 身份字段统一使用 username 语义。网络调用设定 timeout、处理重试幂等，并在 shutdown 时释放客户端资源。

## 反例

- log({ headers: request.headers })。
- reply.send(error)。
- 在事务中上传 S3 文件或调用第三方 HTTP。
- 使用 Buffer 新增一套 base64 协议编码。
