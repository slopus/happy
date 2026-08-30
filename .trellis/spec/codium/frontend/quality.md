# TypeScript、测试与构建

## 类型边界

main、preload、renderer 分别由 tsconfig.node.json 和 tsconfig.web.json 检查。IPC、插件 capability、agent event 和持久化 snapshot 都要有显式接口；外部 JSON 使用 Zod 或验证函数收窄。

## 测试

Vitest 测试与实现同目录，当前重点覆盖纯逻辑与 main 持久化：

- sources/theme/__tests__/derive.test.ts：主题派生与 snapshot
- sources/boot/main/worktree-names.test.ts：worktree 命名
- sources/boot/main/app-storage.test.ts：持久化与恢复
- sources/boot/main/agent-worker/codex-cli.test.ts：agent CLI 边界

React UI 改动需要运行 Electron 视觉验证，交互或视觉变更提供截图/录屏。IPC 改动同时覆盖成功、非法输入、worker 退出与 listener 清理。

## 命令

    pnpm --filter codium typecheck
    pnpm --filter codium test
    pnpm --filter codium build
    pnpm --filter codium dev

## 完成标准

- node 与 web 两套 TypeScript 均通过。
- 相关 Vitest 与 Electron 构建通过。
- renderer 没有新增 Node 直接依赖。
- IPC API 同步更新 preload 声明。
- 主题改动在 light/dark 与 contrast 端点验证。
- 状态 hydrate 不恢复瞬时 streaming/error。
- 凭据和完整 agent 环境不进入 renderer snapshot 或日志。
