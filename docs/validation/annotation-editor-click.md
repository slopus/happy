# 消息批注输入框点击后消失

## 结论与范围

已在同一会话保留两个页面实例的条件下复现并修复消息批注编辑器误关闭。
用户截图所处原页面是否确有两个实例尚未直接采集；正式 Web 的独立单实例页面没有复现。
开发验收时修改位于 `fix/annotation-editor-click` 分支；下述浏览器结果为发布前验证。
后续源码合并、CI 发布与正式设备验收分别记录于 Release OPS 本次任务档案。

## 原因

`editRequest` 是模块全局状态，原实现让每个相同 `sessionId` 的 `AnnotationComposer`
都创建编辑器 Portal。两份编辑器重叠，分别监听捕获阶段的 `pointerdown`；点击其中
一份的 textarea，被另一份判断为外部点击，从而清空全局请求并关闭全部编辑器。
同会话任一 Composer 卸载也会无条件清理别的实例打开的编辑器。

桌面导航栈保留背景页面，项目工作区与普通会话页也都可嵌入 `SessionView`，因此
`sessionId` 不能作为编辑器所属页面实例的唯一标识。

## 修改

- 使用请求已记录的真实焦点返回节点区分所属实例。
- 汇总列表打开的编辑器由该 Composer 的触发器独占。
- 正文徽标或新选区打开的编辑器由对应消息 Source 独占，Portal 保持在正文选区事件容器外。
- 清理只影响实际打开编辑器的实例；另一个页面卸载时保留当前编辑草稿。
- 所属实例离开后清理临时编辑请求，保留已保存评论。文件批注宿主的多实例行为未改动。

## 验证

基线为 `7aca3b53418e8fca7c26cb1d708c5ac9d5794904`。

1. 原有组件测试 9 项通过。
2. 新增双页面回归先出现 4 项预期失败：点击输入框导致编辑器数变为 0、重复生成 2 个编辑器、
   列表入口和徽标入口都在其他页面卸载时丢失草稿。
3. 修复后批注相关 29 项通过，包含新增选区、真实 DOM `pointerdown`、保存、Escape、
   所属/非所属实例卸载，以及初始无批注后出现汇总触发器的清理。
4. `pnpm --filter happy-app typecheck` 通过。
5. `pnpm --filter happy-app exec vitest run`：590 个测试文件、5,421 项测试全部通过。
6. 独立代码评审无阻断项。

正式入口的单实例 Ego 验证：1 个 Composer、1 个编辑器，真实点击输入框后编辑器保持打开
且焦点正确。本轮临时批注已删除，恢复 0 批注；未发送消息或修改配置。
该结果仅证明单实例路径正常，不能代替双实例修复验收或用户原端验收。
浏览器可复用方法维护于 `ego-ops/references/sites/paws/operations/inspect-message-annotation-editor.md`，
对应索引已更新，知识校验通过。

隔离浏览器使用真实组件同时挂载两个页面，Ego 真实鼠标对比结果：

- 修复前点击徽标生成 2 个编辑器，再点击上层 textarea 后编辑器变为 0。
- 修复后 A/B 徽标和汇总入口均仅生成 1 个编辑器；真实点击、键入、保存及读回一致。
- React 生命周期检查确认非所属页面卸载保留未保存输入，所属页面卸载清理请求并保留已保存评论。
- 修复前、修复后点击输入和最终可编辑状态的 3 张关键帧已上报本会话 Skills。
- 浏览器空间和本轮临时服务已关闭。完整夹具报告见本 worktree 被忽略的
  `test-results/annotation-editor-browser/verification.md`，该夹具不代表正式账号持久层或用户原设备已验收。

浏览器验证的源码 SHA256 为 `be3363fff08a89b63e61c761dc8e12fc9677978f70bea4b5458c327bba3bb82d`，
与当前修复文件一致。Ego OPS 操作经验实际位于
`/Users/jacky/.codex/skills/ego-ops/references/sites/paws/operations/inspect-message-annotation-editor.md`；
站点与总索引同步维护，知识校验为 67 站点、359 operations 通过。
