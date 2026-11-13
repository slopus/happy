# Task 反选与全局范围

集成基线：cc6bbed872b83b897e4813f329d3c1090b7598c5。用户弃用前六版静态稿，保留当前正式组件的布局和样式，只增加再次点击已选 Task 卡片取消选择。

反选清除 Task 会话、author 和文件上下文，保留当前项目/feature；右侧默认显示该范围的全局文件树。复用主线现有全局会话查询与创建流程，先确定会话再一次导航，不发送指令。一次 Back 回原 Task，Forward 回既定全局会话。离线且无可用历史时仍展开全局文件，不创建会话。

2026-11-13 验证：

- 合入最新主线后五个相关测试文件共 40 项通过，App typecheck 通过；覆盖全局文件根、会话关闭不重开、会话验证与历史切换。原分支的自动进入 effect 已移除，改为复用主线显式全局会话动作。
- 独立代码复核通过，确认无样式修改。
- Ego 在 1680×960 的隔离完整 App、真实本机中继及加密 RPC 中完成：Task 反选显示全局文件树与空会话；Back/Forward 保留两种范围的草稿；选择另一 Task 后反选复用全局会话；全局树可见兄弟 Task 目录。三张绑定本会话的关键帧已回传 Skills。
- 执行器是 fixture stub，只创建真实隔离会话，不启动模型；发送/提交次数均为 0。未验证真实模型修改其他 Task。
- 用户已确认不需要前后对照；未要求视频。没有正式上线或 OTA 发布。

复跑：

```sh
pnpm --filter happy-app exec vitest run sources/components/goalBoard/ProjectOverviewWorkspace.test.tsx sources/components/goalBoard/projectNavigation.test.ts sources/components/goalBoard/useProjectNavigation.test.tsx
pnpm --filter happy-app typecheck
```

持续交互回归加入现有 `e2e/fixtures/project-goals/verify-task-flow.ego.mjs` 的 TF8。使用 fixture README 的隔离环境和已记录的 Ego 空间/目标。本轮只执行本需求对应的三条路径，没有重跑该脚本其余七条既有 Case。
