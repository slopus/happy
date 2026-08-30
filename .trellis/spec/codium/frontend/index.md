# Codium 规范

## 适用范围

packages/codium 是 Electron 41 桌面客户端，由 main、preload 与 React renderer 三个信任区组成。它使用 React 19、Jotai、Electron IPC、agent worker、插件 host、SQLite/本地持久化和自有主题系统。

## 先读什么

- Electron 与 worker 边界：electron-boundaries.md
- React、Jotai、路由和插件 UI：components-state-and-routing.md
- CSS token 与主题：theme-and-styling.md
- 测试与构建：quality.md
- 视觉系统来源：packages/codium/design-system.md

## 关键入口

- sources/boot/main/index.ts：Electron 主进程与 IPC 注册
- sources/boot/preload/index.ts：contextBridge 白名单
- sources/main.tsx 与 sources/providers.tsx：renderer 启动
- sources/app/routes.tsx：React Router
- sources/agents/agent-bridge.ts：renderer 侧 agent API
- sources/boot/main/agent-worker：隔离的 agent runtime
- sources/plugins：插件合同、host 与内置插件
- sources/theme：主题输入、派生与 preset
