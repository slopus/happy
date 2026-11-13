# Task 面板连续性回归

基线：`0f98275e229550143f216c1d85a25f1838fe73fe`。

## 范围与实现

沿用现有卡片、主题、文件区和多栏尺寸公式。仅修改反选时是否进入全局会话，以及跨 Task 重挂载时保留行宽测量。账号／机器切换仍重置测量；Task 数据和文件 Provider 仍按原 key 隔离。

| Case | 通过标准 | 实际结果 |
| --- | --- | --- |
| PC1 | 会话关闭时反选：全局树显示，聊天不打开，不创建会话 | 通过；额外确认全局 tasks/index.md 真实条目载入 |
| PC2 | 会话打开时反选：切全局会话，草稿与前进/返回保留 | 通过；仅首轮建立一个全局空会话，复跑复用 |
| PC3 | 不同 Task 切换：详情栏不先收窄，保持位置 | 通过；1680/1280 两种宽度，双向各 13 个样本，x/y/width 最大变化 0，无横向溢出 |

## 验证入口

- 普通与回放：`packages/happy-app/e2e/fixtures/project-goals/verify-panel-continuity.ego.mjs`，只通过 Ego 运行。
- 先启动已有 `serve.mjs` 完整 App 隔离环境，读取它生成的 `runtime.json`。认证 URL 从私有文件读取，不打印或提交。
- 新建并记录本轮 Ego 数字 taskSpaceId、精确 targetId 和统一 runId；设置 `globalThis.projectPanelContinuityConfig = { runtimePath, taskSpaceId, targetId, runId }` 后导入脚本。
- 普通结果写入 runtime 同目录的 `panel-continuity/results.json`；`record: true` 回放写入 `panel-continuity-replay/`。`onlySwitch: true` 可在前两个 Case 完成后仅补跑 PC3。
- 原有 `verify-task-flow.ego.mjs` 的 TF8 已同步区分会话关闭／打开两种情况；本轮只跑聚焦入口，没有重复整套历史 E2E。

PC3 在真实点击前安装一次性监听，从点击当刻及之后的 animation frame 取面板几何，包含重挂载后的第一帧。比较 x/y/width；视口高度由浏览器控制，不用它判断栏宽回归。账号隔离与首渲染宽度另由组件测试保护。

## 自动检查与独立评审

- `ProjectWorkspaceWidth`、工作区布局、全局工作区、导航、会话解析和会话头：7 文件共 47 项通过。
- OTA runtime 契约：7 项通过。
- `pnpm --filter happy-app typecheck` 通过。
- `git diff --check` 通过。
- 独立代码复核通过：测量状态位于账号／机器 Owner 内，Task 的文件与数据隔离保留，关闭分支不解析／创建全局会话。

- 独立 PC 交互回归评审：PC1、PC2、PC3 均通过；核对真实状态帧、草稿/历史断言及逐帧几何结果。

## 证据与边界

功能关键帧通过 Happy Skills 上报；用户已明确不需要 PR 前后对照。普通模式及回放使用真实完整 App、独立服务／账号与加密 RPC，目标与文件为合成数据；启动器是建立真实隔离空会话的替身，不启动生产模型。提交／接收均为 0。

视频为回放的关键状态演示，稳定性结论来自逐帧几何断言；不把状态演示称为连续屏幕录像。未验证原生真机、手机播放、真实模型修改其他 Task 或全站其他交互。正式发布及线上版本核验另留发布回执，不复用旧 PR 的上线结论。
