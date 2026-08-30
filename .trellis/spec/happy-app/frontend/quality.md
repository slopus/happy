# 质量与验证

## TypeScript

tsconfig 开启 strict，内部导入使用 @/ 指向 sources。wire 或持久化边界先用 Zod/显式解析收窄 unknown，不用 any 代替协议建模。

## 测试位置

Vitest 测试与实现同目录，仓库同时存在 .test.ts 和 .spec.ts；新增测试跟随所在目录的主流命名。优先测试可观察行为和纯逻辑：

- packages/happy-app/sources/sync/reducer/reducer.spec.ts：复杂同步状态机
- packages/happy-app/sources/hooks/useGroupedMessages.test.ts：消息分组
- packages/happy-app/sources/utils/toolDisplay.test.ts：展示归一化
- packages/happy-app/sources/utils/codexUnifiedDiff.spec.ts：协议文本解析

平台组件改动除单元测试外，还要在受影响的平台运行验证。贡献指南要求 PR 展示真实运行结果；视觉改动提供截图或录屏。

## 常用命令

从仓库根目录运行：

    pnpm --filter happy-app typecheck
    pnpm --filter happy-app test -- --run
    pnpm --filter happy-app web

只跑相关测试时：

    pnpm --filter happy-app exec vitest run sources/utils/toolDisplay.test.ts

## 完成标准

- 类型检查通过。
- 受影响的 Vitest 通过。
- 新用户文案已覆盖所有语言。
- 同步/协议改动覆盖重复、乱序或非法输入。
- iOS、Android、Web、Tauri 中受影响的平台已做比例合适的运行验证。
- 没有顺手重构无关代码。
