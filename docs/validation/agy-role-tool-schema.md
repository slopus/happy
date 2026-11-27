# AGY 角色与委派工具目录兼容验收

## 问题与修复边界

早期正式 AGY 验收中，`delegate_task` 和 `read_delegated_task` 在默认权限下已完成，但 `agent_roles(action=list)` 收到原生 `unknown tool`。实际 HTTP 与同版 STDIO 目录都包含该工具。后续隔离样本也出现过委派工具原生查找失败，不能仅凭单次模型采样确定 schema 根因。

隔离对照保留同一份 23 工具目录和静态只读 handler，只改变 `agent_roles.patch.model/effort` 的两个可空字段。原 schema 的短回合未调用角色工具；改为标准等价的 `type: [string, null]` 后，原生调用到达许可阶段，并完成严格 `action=list` 的静态空列表读取。该证据验证当前原生链路的兼容表示，不宣称所有 AGY 版本均不支持 `anyOf`，也不把未调用本身当作过滤原因的独立证明。

后续 E 隔离目录保留上述角色字段表示，仅将 `delegate_task.inputSchema` 改为单个必填字符串 `payload`，禁止 wrapper 外层额外字段。同一原生会话中的角色列表、委派 payload、再次角色列表三次静态调用均完成。该 handler 只核对不透明字符串，没有执行 JSON 业务解析或真实委派；许可界面显示的标题也不能证明底层 native function 名称。

补修仅在 AGY 启用 `--schema-profile antigravity`。STDIO transport 按 `tools/list` 请求和响应 ID 关联，转换上述两个精确角色 schema 叶子，并替换委派工具的输入 schema；工具名称、标题、描述和元数据保持原样。默认 bridge、HTTP 目录、其他工具和其他 RPC 结果沿用原行为。

AGY 收到具有字符串或数字 RPC ID 的 `tools/call` 请求时，仅对精确名为 `delegate_task`、arguments 恰有一个自有字符串字段 `payload` 的请求尝试解码。先限制 UTF-8 编码大小为 2 MiB，再进行一次 JSON 解析；只有非 null 且非数组的对象才替换 `params.arguments`。RPC ID、元数据及参数值保持原样，原 MCP SDK、严格 Zod validator 和注册 handler 继续执行全部业务校验。适配层不补默认值、不合并外层字段、不删未知字段，也不转换别名；原有 canonical 委派参数仍可直接调用。

## 验收契约

| 场景 | 要求 |
| --- | --- |
| AGY 角色目录 | 两个字段使用等价类型数组，保留原字符串约束和可空语义 |
| AGY 委派目录 | 仅输入 schema 使用必填字符串 `payload`，且 `additionalProperties: false` |
| 委派 payload | 有效对象完整交给原 validator；引号、换行、中文及较大合法参数不丢失 |
| 无效 wrapper | 非字符串、额外字段、超限、错误 JSON 或非对象不解码，交由原严格 validator 正常拒绝；同一连接后续请求仍可使用 |
| 普通 bridge | 保持原目录和 transport |
| 清除已设型号/强度 | `null` 原样通过原 validator 和 handler，保留恢复原生默认的合同 |
| 错误参数 | 非法类型、空字符串、未知字段及与 action 不符的参数继续拒绝 |
| RPC 关联 | 保留 ID 类型，关联仅消费一次；不把看似工具目录的其他 RPC 结果当作目录转换 |
| 生命周期 | 结果、错误响应、取消、关闭、启动和发送失败均有相应关联清理；同时在途目录请求有明确上限 |
| 正式入口 | 新 AGY 默认权限会话实际完成角色列表、单个原生默认子任务及结果回流，再精确清理测试对象 |

## 已有验证与未完成项

新增 payload 用例先观察到缺失目录适配与解码的回归失败；实现后 schema profile 与真实 STDIO 两个测试文件共 49 项通过。测试使用真实 MCP SDK、原注册和 validator，仅替换外部业务端点，不调用真实角色写操作。覆盖 wrapper 精确边界、UTF-8 字节上限、原参数校验、默认 bridge 不变，以及错误请求后同一连接继续成功。本地源码 `pnpm exec tsc --noEmit` 和 `pnpm run build` 均通过。

冻结候选、准确源码 CI、正式激活和当前设备操作由本任务交付记录继续核验。E 的静态 native 成功及本地协议测试都不替代正式当前设备业务验收。

本次没有输入区域增量，沿用已有消息和角色工具流程；不改变 App 原生运行合同。
