# AGY 角色工具目录兼容验收

## 问题与修复边界

正式 AGY 验收中，`delegate_task` 和 `read_delegated_task` 在默认权限下已完成，但 `agent_roles(action=list)` 收到原生 `unknown tool`。实际 HTTP 与同版 STDIO 目录都包含该工具，错误发生在 AGY 原生查找层。

隔离对照保留同一份 23 工具目录和静态只读 handler，只改变 `agent_roles.patch.model/effort` 的两个可空字段。原 schema 的短回合未调用角色工具；改为标准等价的 `type: [string, null]` 后，原生调用到达许可阶段，并完成严格 `action=list` 的静态空列表读取。该证据验证当前原生链路的兼容表示，不宣称所有 AGY 版本均不支持 `anyOf`，也不把未调用本身当作过滤原因的独立证明。

补修仅在 AGY 启用 `--schema-profile antigravity`。STDIO transport 按 `tools/list` 请求和响应 ID 关联，仅转换上述两个精确 schema 叶子；保留字符串约束、可空语义和原有业务参数及 Zod 校验。默认 bridge、HTTP 目录、其他工具和其他 RPC 结果沿用原行为。

## 验收契约

| 场景 | 要求 |
| --- | --- |
| AGY 工具目录 | 两个字段使用等价类型数组，其余目录内容不变 |
| 普通 bridge | 保持原目录和 transport |
| 清除已设型号/强度 | `null` 原样通过原 validator 和 handler，保留恢复原生默认的合同 |
| 错误参数 | 非法类型、空字符串、未知字段及与 action 不符的参数继续拒绝 |
| RPC 关联 | 保留 ID 类型，关联仅消费一次；不把看似工具目录的其他 RPC 结果当作目录转换 |
| 生命周期 | 结果、错误响应、取消、关闭、启动和发送失败均有相应关联清理；同时在途目录请求有明确上限 |
| 正式入口 | 新 AGY 默认权限会话实际完成角色列表、单个原生默认子任务及结果回流，再精确清理测试对象 |

## 已有验证与未完成项

实现前已观察真实 STDIO profile/参数路由及协议回归失败；实现后 3 个相关文件、127 项回归通过。测试使用真实 MCP SDK 和 STDIO，外部业务端点替换为静态 handler，不调用真实角色写操作。

构建、冻结候选、准确源码 CI、正式激活和当前设备操作由本任务交付记录继续核验，不以隔离 native stub 或单测替代正式验收。

本次没有输入区域增量，沿用已有消息和角色工具流程；不改变 App 原生运行合同。
