# Orchestrator 使用场景与示例

Orchestrator 通过 Claude Code MCP 工具（`orchestrator_submit`、`orchestrator_pend`、`orchestrator_list`、`orchestrator_cancel`、`orchestrator_get_context`）调用。

## 核心能力速查

| 能力 | 适用场景 |
|------|---------|
| **并行执行** | 多包测试、多视角审查、批量修改、批量生成 |
| **DAG 依赖** | 流水线（设计→实施→测试）、先调研再动手、数据库迁移顺序 |
| **多机调度** | 跨机器协作、分布式任务、隔离环境执行 |
| **重试** | 网络不稳定、数据库锁超时、外部 API 限流 |
| **maxConcurrency** | 资源受限时控制并发数，避免打满 CPU/内存/API 配额 |

---

## 场景 1：多包并行测试

monorepo 里改了共享类型，想同时跑多个包的测试。

```json
{
  "title": "全包测试",
  "mode": "blocking",
  "tasks": [
    {
      "taskKey": "test-server",
      "provider": "claude",
      "prompt": "在 packages/happy-server 目录下运行 yarn build，如果有类型错误请列出",
      "workingDirectory": "/path/to/project"
    },
    {
      "taskKey": "test-cli",
      "provider": "claude",
      "prompt": "在 packages/happy-cli 目录下运行 yarn typecheck，如果有类型错误请列出",
      "workingDirectory": "/path/to/project"
    },
    {
      "taskKey": "test-wire",
      "provider": "claude",
      "prompt": "在 packages/happy-wire 目录下运行 yarn typecheck，如果有类型错误请列出",
      "workingDirectory": "/path/to/project"
    }
  ]
}
```

**价值**：3 个包同时检查，时间从串行 3 倍缩短到 1 倍。

---

## 场景 2：多视角 Code Review

让不同 agent 从不同角度审查同一段代码。

```json
{
  "title": "多视角审查 orchestratorRoutes.ts",
  "mode": "blocking",
  "tasks": [
    {
      "taskKey": "security",
      "provider": "claude",
      "prompt": "审查 packages/happy-server/sources/app/api/routes/orchestratorRoutes.ts 的安全性：注入风险、权限校验、输入验证、敏感信息泄露"
    },
    {
      "taskKey": "performance",
      "provider": "claude",
      "prompt": "审查 packages/happy-server/sources/app/api/routes/orchestratorRoutes.ts 的性能：N+1 查询、缺少索引、大结果集、不必要的 await"
    },
    {
      "taskKey": "correctness",
      "provider": "codex",
      "prompt": "审查 packages/happy-server/sources/app/api/routes/orchestratorRoutes.ts 的逻辑正确性：边界条件、竞态条件、错误处理遗漏、状态机转换"
    }
  ]
}
```

**价值**：3 个 agent 各带一个专注视角，比单个 agent 做全面 review 更深入。

---

## 场景 3：流水线式功能开发（DAG）

用依赖关系编排：先设计接口 → 再并行实现前后端 → 最后集成测试。

```json
{
  "title": "新增用户导出功能",
  "mode": "blocking",
  "tasks": [
    {
      "taskKey": "design",
      "provider": "claude",
      "prompt": "设计一个用户数据导出 API：定义 REST 端点路径、请求/响应 schema（Zod）、导出格式支持 CSV 和 JSON。只输出接口定义，不要实现。"
    },
    {
      "taskKey": "backend",
      "provider": "codex",
      "prompt": "根据仓库中最新的导出 API 设计，在 happy-server 中实现导出端点。参考现有路由的风格。",
      "dependsOn": ["design"]
    },
    {
      "taskKey": "frontend",
      "provider": "codex",
      "prompt": "根据仓库中最新的导出 API 设计，在前端添加'导出'按钮和调用逻辑。参考现有页面的组件风格。",
      "dependsOn": ["design"]
    },
    {
      "taskKey": "integration-test",
      "provider": "claude",
      "prompt": "为用户导出功能编写集成测试，覆盖 CSV 和 JSON 两种格式，包含空数据、大数据量边界情况。",
      "dependsOn": ["backend", "frontend"]
    }
  ]
}
```

**价值**：design 完成后 backend 和 frontend 自动并行启动，都完成后才跑集成测试。全程无需人工盯着。

---

## 场景 4：数据库迁移流水线（DAG + 重试）

迁移操作需要严格顺序，且迁移步骤可能因锁超时失败需要重试。

```json
{
  "title": "数据库迁移",
  "mode": "blocking",
  "tasks": [
    {
      "taskKey": "backup",
      "provider": "claude",
      "prompt": "执行数据库备份：运行 pg_dump 导出当前数据库到 /tmp/backup-$(date +%Y%m%d).sql",
      "retry": { "maxAttempts": 2, "backoffMs": 5000 }
    },
    {
      "taskKey": "migrate",
      "provider": "claude",
      "prompt": "运行 npx prisma migrate deploy 执行待处理的数据库迁移",
      "dependsOn": ["backup"],
      "retry": { "maxAttempts": 3, "backoffMs": 10000 }
    },
    {
      "taskKey": "verify",
      "provider": "claude",
      "prompt": "验证数据库迁移结果：检查新表/列是否存在，运行 npx prisma migrate status 确认无待处理迁移",
      "dependsOn": ["migrate"]
    }
  ]
}
```

**价值**：备份 → 迁移 → 验证严格顺序，迁移失败自动重试（比如锁超时），备份失败则整条链不会继续。

---

## 场景 5：跨仓库批量修改

同一个 API 变更需要同步更新多个项目。

```json
{
  "title": "批量升级认证 header",
  "mode": "blocking",
  "tasks": [
    {
      "taskKey": "repo-server",
      "provider": "codex",
      "prompt": "将所有 API 请求的认证 header 从 X-Auth-Token 改为 Authorization: Bearer 格式",
      "workingDirectory": "/home/coder/projects/api-server"
    },
    {
      "taskKey": "repo-web",
      "provider": "codex",
      "prompt": "将所有 API 请求的认证 header 从 X-Auth-Token 改为 Authorization: Bearer 格式",
      "workingDirectory": "/home/coder/projects/web-client"
    },
    {
      "taskKey": "repo-mobile",
      "provider": "codex",
      "prompt": "将所有 API 请求的认证 header 从 X-Auth-Token 改为 Authorization: Bearer 格式",
      "workingDirectory": "/home/coder/projects/mobile-app"
    }
  ]
}
```

**价值**：3 个仓库同时改，每个 agent 在各自仓库的目录下工作，互不干扰。

---

## 场景 6：调研 + 实施（先调研再动手）

不确定最佳方案时，先让多个 agent 并行调研，再根据结果实施。

```json
{
  "title": "WebSocket 方案选型与实施",
  "mode": "blocking",
  "tasks": [
    {
      "taskKey": "research-socketio",
      "provider": "claude",
      "prompt": "调研 Socket.IO 在 Fastify 中的集成方案，列出优缺点、内存占用、集群扩展能力"
    },
    {
      "taskKey": "research-ws",
      "provider": "claude",
      "prompt": "调研原生 ws 库在 Fastify 中的集成方案，列出优缺点、内存占用、集群扩展能力"
    },
    {
      "taskKey": "implement",
      "provider": "codex",
      "prompt": "根据项目中已有的 WebSocket 方案调研结论，选择更优方案并实施。如果两个方案各有优劣，优先选择与现有架构兼容性更好的。",
      "dependsOn": ["research-socketio", "research-ws"]
    }
  ]
}
```

**价值**：并行调研省时间，DAG 保证调研完成后再实施，避免拍脑袋选型。

---

## 场景 7：带容错的批量文件处理

处理大量文件时，单个失败不应阻塞整体。

```json
{
  "title": "批量生成 API 文档",
  "mode": "blocking",
  "maxConcurrency": 3,
  "tasks": [
    {
      "taskKey": "doc-auth",
      "provider": "claude",
      "prompt": "为 routes/auth.ts 中的所有端点生成 OpenAPI 文档注释",
      "retry": { "maxAttempts": 2, "backoffMs": 2000 }
    },
    {
      "taskKey": "doc-users",
      "provider": "claude",
      "prompt": "为 routes/users.ts 中的所有端点生成 OpenAPI 文档注释",
      "retry": { "maxAttempts": 2, "backoffMs": 2000 }
    },
    {
      "taskKey": "doc-projects",
      "provider": "claude",
      "prompt": "为 routes/projects.ts 中的所有端点生成 OpenAPI 文档注释",
      "retry": { "maxAttempts": 2, "backoffMs": 2000 }
    },
    {
      "taskKey": "doc-tasks",
      "provider": "claude",
      "prompt": "为 routes/tasks.ts 中的所有端点生成 OpenAPI 文档注释",
      "retry": { "maxAttempts": 2, "backoffMs": 2000 }
    }
  ]
}
```

**价值**：`maxConcurrency: 3` 控制同时运行数量避免资源打满，每个任务自带重试，单个失败不影响其他。

---

## 关于重试的注意事项

重试机制在 **agent 层面失败**时触发（进程崩溃、超时、调度失败），而不是 agent 内部执行的命令返回非零退出码时触发。

例如，prompt 为 `"run command: exit 1"` 时，agent 会成功完成该任务（因为它成功执行了你让它做的事），不会触发重试。要测试重试，可以使用短超时 + 长任务的方式制造 agent 超时。
