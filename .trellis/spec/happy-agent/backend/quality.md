# 质量与发布

## TypeScript 与风格

本包使用 ESM、strict TypeScript 和 Node.js 20+。保持小型函数模块，导出接口显式类型化。运行时外部数据先解析为 unknown，再收窄；测试中已有的局部 mock 不代表生产代码可使用 any。

## 测试

测试与 src 文件同目录，使用 .test.ts。单元测试允许通过 vi 隔离网络、时间和文件系统；跨服务行为放 vitest.integration.config.ts 管理的集成测试。

关键测试：

- src/index.test.ts 与 src/cli-smoke.test.ts：命令契约
- src/output.test.ts：human/JSON 输出
- src/credentials.test.ts：权限与持久化
- src/happy-agent.integration.test.ts：真实服务交互

## 命令

    pnpm --filter happy-agent typecheck
    pnpm --filter happy-agent test
    pnpm --filter happy-agent test:integration
    pnpm --filter happy-agent build

协议或发布改动至少执行 typecheck、test 和 build。集成测试需要明确配置服务环境，不把个人凭据写入 fixture。

## 发布约束

package.json 的 files 只发布 dist、bin 和 package.json。bin/happy-agent.mjs 必须继续指向构建产物。新增运行时依赖要放 dependencies，不得依赖 monorepo 中未声明的源码路径。
