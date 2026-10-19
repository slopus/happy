# PC Web 批量批注验收

在 Happy 长回复中选中不同段落，保存原文及可选评论；输入区汇总支持铅笔回填、保存、取消和删除，最后统一提交。

2026-10-19，本地隔离完整页面的下列11项Case普通模式和同组录像复跑均通过。原始正文及执行器完成状态为合成数据，实际页面经既有暂存队列、加密与真实本地服务端存储；未调用外部模型，不是生产或原生真机验收。

[逐状态验收视频](acceptance.mp4)：8个成功复跑状态，各2.2秒，共17.6秒；H.264/yuv420p、1440×900、30fps、静音。视频已做完整解码和覆盖首中尾的视觉检查，并发送Happy。它是逐状态演示，不是连续录屏。手机实际播放待用户验证。

| Case | 通过标准 | 视频证据 |
| --- | --- | --- |
| ANN-01 | 真实鼠标跨Markdown粗体选择，保存后仅批注也可发送 | 00:00–00:02.2 首条原文与评论 |
| ANN-02 | 四条批注、可选空评论、重复原文不同位置 | 00:02.2–00:06.6 编辑及汇总 |
| ANN-03 | 铅笔回填、保存同一条、Escape取消不覆盖 | 00:02.2–00:04.4 回填编辑器 |
| ANN-04 | 删除同步、刷新恢复三条批注 | 00:04.4–00:06.6 恢复结果 |
| ANN-05 | A→B→A会话草稿隔离 | 自动断言，视频未单列过程 |
| ANN-06 | 暂存持久化失败后草稿保留，服务端无新增 | 00:06.6–00:08.8 保留结果 |
| ANN-07 | 单击只新增一条服务端消息，原文与问题正确配对 | 00:08.8–00:11.0 批量消息 |
| ANN-08 | 仅批注时Enter提交 | 自动断言，视频未单列过程 |
| ANN-09 | Gingham深色普通、hover、所选原文状态 | 00:13.2–00:15.4 深色汇总 |
| ANN-11 | 已接受后清理失败独立提示已提交，当前草稿退休且不重复发送 | 00:11.0–00:13.2 已提交提示 |
| ANN-10 | 390px长评论编辑器和保存按钮均在视口内 | 自动断言及已报告窄屏关键帧，未加入桌面视频 |

账号namespace隔离及提交期间新增/修改草稿的快照清理由单测覆盖，不等同两个真实账号的浏览器验收。本轮修正后51项关联单测、7项runtime契约、类型检查与Web export通过；前轮68项关联测试结果保留。夹具信号退出处理已修复并有源码生命周期smoke。存储整体拒绝写时无法保证跨刷新清理，专用已提交提示明确披露可能恢复旧缓存、请勿重复提交。独立代码及桌面静态评审见[review.md](review.md)。

## 复跑

```sh
pnpm exec tsx packages/happy-app/e2e/fixtures/message-annotations/serve.mjs
pnpm --filter happy-app exec vitest run sources/components/annotations
pnpm --filter happy-app exec tsc --noEmit --incremental false
CI=1 HAPPY_E2E_DISABLE_WATCHMAN=1 pnpm --filter happy-app export:web
```

夹具ready后，读取生成的runtime.json取得本轮隔离环境入口；认证URL仅从环境私有文件读到浏览器，禁止打印或录制凭据。按ego-ops→ego-browser加载同任务空间，在Ego nodejs导入 `verifyMessageAnnotations`（packages/happy-app/e2e/fixtures/message-annotations/verify.ego.mjs），先record:false，再record:true；明确传入当前任务空间、准确target、同runId及当前Happy session。所有本机路径使用绝对路径，不复用另一轮动态ID或端口。

结束先报告最终验证状态、独立finish任务空间，再SIGTERM该serve进程，清理其独立服务与数据；主daemon和生产服务不参与测试。
