# Codex 设置浮层视觉修正

基线：`6b065ad2da708ac4f0e2d726a57c0131f2d651a4`；分支：`fix/codex-settings-track`。

按用户 2026-11-11 的三张参考图修正：完整底轨、去除底部文字、收起入口透明。

| Case | 通过标准 | 结果 |
|---|---|---|
| RAIL | 深色照片皮肤和浅色均能看到完整底轨；白色滑块高于轨道 | DreamSkin dark、Gingham light 实际完整 App 检查通过；轨道独立 token 与暗色对比回归通过 |
| COMPACT | 滑轨下方没有说明、Fast 状态或默认档文字，仍能恢复默认 | 右上角恢复图标调用原 default 回调；组件及真实页面通过 |
| TRIGGER | 普通入口透明，按下/展开有底色，关闭后透明 | 真实页面读回透明及 Escape 焦点恢复通过 |

## 实现与检查

轨道之前与弹层都映射到 surfaceHigh；新增语义 slider.track，以当前主题的面板和次要文字色混合，保持主题中性灰。轨道完整绘制，白色滑块 36px、轨道 32px，已选圆点为浅色。底部文字移除，default 仍为自动档，不加入数值档位。

50 项相关测试、7 项 Android runtime 契约、TypeScript 与 diff whitespace 检查通过。独立代码审查通过。

使用既有 codex-settings 完整 App fixture，隔离 PGlite、合成模型目录、真实加密传输及 stub 执行器；不调用外部模型，不触碰正式账号。新建与会话中共用真实组件，非 Codex 和原生选择器路径未改。

## 可视证据

1440×900、DPR 1。Before/After 均为同一合成会话、GPT-6.1 Terra / high / Fast off、Caramel dark；首次语言同步使部分周边文案语言不同，不用于周边像素比较。

| 修正前 | 修正后 |
|---|---|
| [Before](codex-settings-track-media/chat-before.png) | [After](codex-settings-track-media/chat-after.png) |

补充：[DreamSkin 深色](codex-settings-track-media/dreamskin-after.png)、[Gingham 浅色](codex-settings-track-media/light-after.png)、[入口收起](codex-settings-track-media/trigger-closed-after.png)。关键帧使用当前 Happy session、独立 run、数值 task space、精确 target/URL 绑定采集，并逐张上报 Skills，无重复普通图片附件。

## 视频

[14 秒验收演示](codex-settings-track-media/acceptance.mp4)：Gingham dark，入口收起 → 展开 → 中档 → 恢复默认 → 高档 → Escape。由本轮新鲜 CDP 状态帧生成，属于逐状态演示，不是连续录屏。1440×900、H.264/yuv420p、30fps、TV range、faststart，完整解码退出 0，六状态逐一视觉核对；Happy send_file 发送成功。未声称手机实际播放确认或手机已加载 OTA。

## 独立交互回归

独立 reviewer 的 PC 回归通过：新建与会话中完整底轨、无底部文字；恢复默认保持模型/Fast；拖动释放、Fast Space、Fast 能力切换、Escape 与焦点返回均通过。Gingham dark 普通入口透明，pressed/open 均 rgb(40,53,68)，底轨 rgb(76,90,104)，面板 rgb(31,42,56)。[新建页关键截图](codex-settings-track-media/new-after.png)由 reviewer 独立绑定并上报 Skills。
