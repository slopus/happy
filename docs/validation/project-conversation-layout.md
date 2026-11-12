# 项目会话两栏与按需文件

历史记录：此版隐藏原卡片的布局已由用户反馈修订，当前契约见 [保留原任务卡片](project-visible-cards.md)。以下为PR758当时的验收。

基线：21f381061d9f5394679bfb294a05378c78b667b9。依据用户两张标注图：会话直接出现在详情左侧，移除常驻任务清单/搜索列，文件树按需展开，顶部支持新建和历史切换。

## 最终行为

- Task 和全局目标的会话默认均为“会话＋详情”；任务切换保留详情标题处原有下拉入口。
- 会话顶部直接提供新建按钮及历史菜单。继续优先复用；明确新建才另建空会话。保存各自未发送草稿，不自动提交模型指令。
- 普通文件阅读可以在左侧会话/文件之间切换；显式请求文件树且已有打开文档、宽度足够时，显示“会话＋文件正文＋文件树”。返回详情收起文档分栏并恢复聊天。
- 无会话时打开、恢复或刷新文档不会创建空白聊天列，也不会把文档藏在空白区域。
- 待验证的全局会话先占据聊天位置，历史归属确认后才挂载真实 SessionView，不闪回任务卡片。

## Case 与证据

| Case | 验收标准 | 本地结果 |
| --- | --- | --- |
| CL1 | Task 会话直接在详情左侧，无任务/搜索列，复用不新增 | Pass |
| CL2 | 文件树明确展开后才三栏，返回详情恢复两栏 | Pass |
| CL3 | Task 明确新建、历史往返、草稿隔离；Esc 保持 URL/焦点 | Pass |
| CL4 | 全局目标同样两栏、新建/继续分开、历史不混入 Task | Pass |
| CL5 | 无会话文件阅读刷新恢复，无空白占位 | Pass |
| CL6 | 1680×885 与 1280×720 两→三→两栏无横向溢出 | Pass |

自动检查72项通过（含7项OTA runtime契约），App类型检查通过。独立代码复审、PC截图与执行证据评审通过；评审者未亲自操作浏览器。普通及连续CDP录屏复跑均通过六项，录像复跑明确继续已存在的Scope会话，不把它重复声称为无历史首次创建。

使用完整App、隔离PGlite账号、真实加密RPC/文件；启动器只创建relay会话，未调用模型。每次明确新建动作均断言只增加1份空会话，继续和历史往返不增加会话；多轮复跑产生的合成会话保留，提交和接收始终为0。仅写合成账号的本地草稿，未修改用户业务文件或认可产物。Gingham/dark和照片皮肤下检查布局、动作；原生设备未验。

旧版TF1–TF7回归通过，覆盖入口、复用、草稿、交付编辑、批量草稿、只读目标文件及目录缓存；该轮TaskB已有合成历史，诚实记为复用，另用全新合成任务确认卡片首次新建1份并自动展示，提交0。返回任务列表须等URL清除Task后再点卡片，不能仅凭列表可见判断导航完成。

用户明确不需要PR前后对照，不制作或公开对照矩阵。绑定当前Happy会话的Skills关键帧单独回传，视频为私有验收产物，不等于用户视觉认可。最终通过版本的连续CDP录屏已编码为H.264/yuv420p MP4（1680×886、30fps、20.27秒），首尾非空及完整解码核对通过，已通过Happy媒体卡发送；手机实际播放未人工确认。正式发布结果单独核验。

## 复跑

按 `packages/happy-app/e2e/fixtures/project-goals/README.md` 启动隔离完整App，通过Ego新建一次本任务空间，固定数字ID和p1确切target，再执行：

```js
globalThis.projectConversationLayoutConfig = {
  runtimePath: '/absolute/worktree/packages/happy-app/test-results/project-goals/runtime.json',
  taskSpaceId: recordedTaskSpaceId,
  targetId: recordedTargetId,
  runId: uniqueTaskRunId,
  capture: false,
};
await import('file:///absolute/worktree/packages/happy-app/e2e/fixtures/project-goals/verify-conversation-layout.ego.mjs');
```

结果保存到 ignored 的 `test-results/project-goals/conversation-layout/results.json`。开启capture时须使用当前Happy capture sessionId，不能跨会话复用脚本里的示例上下文。认证URL只在本机读取；结束通过本fixture的 `/shutdown` 关闭服务并核对端口。不要停止正式daemon。
