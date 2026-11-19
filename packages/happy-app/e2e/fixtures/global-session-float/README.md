# 全局会话悬浮窗一对一验收

完整隔离 App，复用 `project-goals/serve.mjs` 的真实 relay、账号与加密会话。无生产数据、模型指令、daemon 或公网部署。

1. 按 project-goals/README 启动完整 fixture，再以仓库 tsx/CLI tsconfig 启动本目录 `activity.mjs`。
2. 仅通过 Ego 建立一个任务空间，记录 numeric space、精确 target、sessionId/runId、root/runtimePath 到私有 `test-results/global-session-float/context.json`。
3. 基线为 943f0e0c 的 SidebarNavigator、SidebarView 与 ProjectSessionMonitor.web；临时备份放在 TypeScript include 之外，或加 `.saved` 后缀，避免备份被编译。只在隔离 worktree 切换源码，不能污染根 main。截图前复核实际版本。
4. Ego 中设置 `globalThis.floatConfig={contextPath,phase:'before'|'after',capture:true,record:false}`，再 import `verify.ego.mjs`；完成普通 after 后，用 `record:true` 复跑同一 Case。
5. 每次 capture 输出须逐条交给 Happy report_browser_step，只上报绑定回执的精确路径。`render.mjs` 从本轮 before-normal 与 after-record 生成独立对比图，不能拿旧截图充当本轮证据。
6. `recordEgoPage` 是对实时页面约500ms一次采样的录像，不声称连续高帧率录屏。使用 FFmpeg 转成 H.264/yuv420p/30fps/faststart；完整解码与全时长抽帧通过后，send_image 发送衍生对比图，send_file 发送 MP4。

| Case | 断言 |
| --- | --- |
| C1 | 侧栏图标存在；开启 ON，关闭无 ON；小窗收起/恢复 |
| C2 | 真实鼠标拖动后 x/y 按位移变化，窗口在视口内；基线位置不变 |
| C3 | 点击 fixture 未读会话；真实输入框可见，窗口保留，未读 1→0；基线窗口消失 |

`activity.mjs` 只允许 loopback，事件化构造 failed/running/completed；`/reset`、`/complete`、`/pulse` 和 `/shutdown` 只作用于本 fixture。重载后在 App 已订阅时单次 `/pulse` 刷新合成机器 presence，不能将缓存内容加载当机器在线。早期截图中的隔离离线提示不影响上述三个窗口断言，但不能用来证明执行器在线。

收尾单次 POST 两个 fixture controller 的 `/shutdown`，核对服务端/Web端口关闭；用 Ego 独立结束任务空间。私有账号文件和runtime不得提交。C3使用空的合成会话，只证明真实会话导航/阅读生命周期，未覆盖真实模型结果正文。
