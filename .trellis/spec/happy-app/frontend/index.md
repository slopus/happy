# Happy App 前端规范

## 适用范围

本目录适用于 packages/happy-app。该包是 Expo 55 + React Native 19 客户端，同时服务 iOS、Android、Web，并由 Tauri 包装 macOS 桌面版本。

## 先读什么

- 页面、组件或样式：components-and-styling.md
- 状态、同步、认证或异步动作：state-sync-and-hooks.md
- 路由、平台边界和目录归属：architecture.md
- 测试与交付：quality.md
- 更深的现有约定：packages/happy-app/CLAUDE.md

## 不可破坏的边界

- 用户可见文本通过 packages/happy-app/sources/text 的 t(...) 获取；开发页除外。新增键必须同步到全部语言文件。
- 主数据由 sources/sync 统一同步、解密和归一化；页面不直接复制一套 Socket.IO 状态。
- 页面使用 Expo Router，静态导航参数优先集中在对应 _layout.tsx。
- UI 优先复用 Item、ItemList、Avatar、Modal 和 components/layout.ts 的宽度约束。
- 样式遵循现有 Unistyles 方案；expo-image 的尺寸和 tintColor 按组件 API 直接设置。
- 改动后至少运行 pnpm --filter happy-app typecheck；相关 Vitest 使用 run 模式执行。

## 关键入口

- packages/happy-app/sources/app/_layout.tsx：根 Provider 与路由入口
- packages/happy-app/sources/app/(app)/_layout.tsx：已登录区域导航配置
- packages/happy-app/sources/sync/sync.ts：同步编排
- packages/happy-app/sources/sync/storage.ts：可订阅的应用状态与查询 hooks
- packages/happy-app/sources/sync/reducer/reducer.ts：消息归并与去重
- packages/happy-app/sources/auth/AuthContext.tsx：认证状态
