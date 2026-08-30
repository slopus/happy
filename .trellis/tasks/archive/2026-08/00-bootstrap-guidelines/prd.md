# Bootstrap Happy 项目规范

## 目标

从现有源码、包级 CLAUDE.md、架构文档、贡献指南和真实测试中提炼 Trellis 规范，使后续会话按 Happy 当前实现工作，而不是加载通用空模板。

## 完成状态

- [x] happy-app：Expo Router、组件、i18n、Unistyles、sync 与测试
- [x] happy-agent：远程控制 CLI、协议、凭据与测试
- [x] happy CLI：provider、daemon、API、持久化、日志安全与测试
- [x] happy-server：Fastify、Socket.IO、Prisma、事件、安全与测试
- [x] happy-server-self-host：发布壳、依赖漂移与 tarball 运行时
- [x] @slopus/happy-wire：共享 Zod 合同、兼容边界与发布
- [x] happy-app-logs：本地接收器、信任边界与验证
- [x] codium：Electron 边界、Jotai、插件、主题与测试
- [x] 横切复用和跨包数据流指南
- [x] 真实源码路径、代码示例与反例

## 最终结构

每个包只保留适用层：

- happy-app/frontend
- happy-agent/backend
- happy/backend
- happy-server/backend
- happy-server-self-host/backend
- happy-wire/backend（内容是共享协议，backend 仅为 Trellis 分组名）
- happy-app-logs/backend
- codium/frontend
- guides

初始化生成但与包职责无关的 frontend/backend 空模板已移除。每个 index.md 都指向同目录的细化规范。

## 证据来源

- AGENTS.md 与 docs/CONTRIBUTING.md
- packages/happy-app/CLAUDE.md
- packages/happy-cli/CLAUDE.md、src/daemon/CLAUDE.md、docs/cli-architecture.md
- packages/happy-server/CLAUDE.md、docs/backend-architecture.md
- packages/codium/design-system.md
- 各包 package.json、src/sources 实现与同目录 Vitest
- GitNexus 当前分支索引与关键执行流查询

## 验证

- 扫描规范中的空模板标记。
- 验证引用的仓库路径存在。
- 运行 Trellis task validate。
- 检查 index 与最终文件集合一致。
- 复核规范只描述当前成立的设计。
