# 项目资料库整理与紧凑布局

用户可见变化：列表上方提供全部、收藏、已归档和已删除筛选及数量；卡片星标独立于项目导航；菜单支持归档、删除确认和恢复。归档/删除仅整理当前设备的列表，保留机器上的档案和会话。状态按账号本地存储和机器/项目路径隔离，独立于七天过期的读取缓存，不承诺跨设备同步。

设计基线为 `c638ceeb`，最终代码已整合 `b40a9207`。卡片从最多三列调整为最多五列、20px 间距、16:9 封面，并精简重复的底部导航行。空心星标在收藏后实心显示；动作使用主题语义颜色，并保留键盘焦点。

## 自动检查

```sh
pnpm --filter happy-app typecheck
pnpm --filter happy-app exec vitest run sources/sync/projectLibrary.test.ts sources/components/goalBoard sources/sync/projectWorkspaceCache.test.ts
pnpm --filter happy-app exec vitest run sources/utils/otaRuntimeConfig.test.ts
```

整合主线后，App typecheck、13 文件 86 项项目工作区相关测试，以及 7 项 Android runtime 契约测试通过。新增测试覆盖状态过滤、恢复收藏、账号与机器隔离、迟到确认拒绝、存储失败不发布视图变更和损坏数据恢复。

## 真实页面验收

使用现有 `e2e/fixtures/project-goals/serve.mjs`，在隔离完整 App、独立 PGlite 账号、加密机器 RPC 和 10 个合成项目中验收；未修改真实项目、daemon 或生产账号，未发送模型指令。

| Case | 实测通过标准 |
| --- | --- |
| PL1 | 星标不触发导航；收藏筛选仅显示收藏项目；整页刷新后保留 |
| PL2 | 归档移出全部/收藏；恢复后收藏状态保留；Esc 关闭菜单且焦点返回触发按钮 |
| PL3 | 删除可取消；确认后移入已删除，刷新仍有效；恢复保留收藏；删除前后选中项目原 index 字节相同 |
| PL4 | 搜索与当前筛选叠加；无结果和取消最后一个收藏有明确空态 |
| PL5 | 1680×885 五列、1366×768 四列、390×844 一列；全部零横向溢出，菜单完整位于视口 |

普通模式和录像模式的 PL1–PL5 均完整通过。主线后来合入 PR761 后，正常合并并解决两处文件冲突，再次通过 App typecheck、14文件93项测试和完整PL1–PL5；子项目新图库保留三列/24px间距/8:5封面，实际两张子卡片宽度相同且无溢出，点击进入正确子项目及其真实合成Task。录像记录 PL1–PL4 的实际操作，PL5 的三种尺寸有单独 DOM 几何证据；1366 和 390 的菜单、1680 的最终列表已通过 Happy 的归属校验关键帧上报。Gingham 深色的普通/hover/selected 表面分别为 `rgb(26,35,48)`、`rgb(31,42,56)`、`rgb(40,53,68)`，取自当前主题。

独立静态代码审查无阻断问题；PC 截图评审确认四列密度、筛选/搜索层级、文字和菜单边界正常。390 帧仅补充窄屏适配，不代表原生设备或独立 Mobile 评审通过。

## 复跑与视频

入口为 `e2e/fixtures/project-goals/verify-project-library.ego.mjs`。先通过 Ego 登录 fixture 的私有认证 URL，导航到带明确机器参数的 `/projects`，记录数字任务空间和确切目标标签页；仅在 Ego 中设置：

```js
globalThis.projectLibraryConfig = { runtimePath, taskSpaceId, targetId };
// 普通模式通过后，增加 record: true 复跑可读操作节奏的视频。
```

再导入该脚本。使用初始未收藏、未归档、未删除的隔离账号；只修改合成账号的本地列表偏好。默认英文 fixture 便于稳定选择确认按钮。结果写入 ignored `test-results/project-goals/library-results.json`。

录像模式在 `test-results/project-goals/library-video` 保存本轮原始 CDP JPEG 与时间记录，不复用截图 helper 或 Ego 的临时截图。最终 H.264/yuv420p/30fps、1680×886、17.23 秒、faststart MP4 已通过完整解码、首中末视觉覆盖检查，并通过 Happy 私人媒体卡发送。视频包含刷新恢复时的离线缓存读回，不代表生产机器或外部模型验收；不虚构公开 PR 视频 URL 或手机实际播放确认。

## 浏览器驱动边界与恢复

首次补验的 Skills 截图采集及旧响应式等待曾中断；经本任务明确授权恢复 Ego 后重做，以上为最新通过结果，旧部分完成状态已被替代。每个恢复后的新任务空间重新记录独立 runId/target，未接管其他页面。

RN Web 在本组件的 button 上未输出 aria-selected，驱动改用当前可访问标签判断收藏状态。响应式模拟、原生 CDP 鼠标输入、布局读回保持在同一 Ego 目标通道，并在两个动画帧后读取实际尺寸；不把“设置了尺寸”当作生效。旧混合 Page 激活/模拟路径未保留所需视口，现有脚本不再依赖该路径或无界等待。

PR 前后对比矩阵未单独选定，本轮关键帧及视频作为验收证据私人交付。原生设备、跨设备同步不在本次验收范围。正式合并发布的精确版本和运行回执按本机 Release OPS 唯一记录维护，不把候选页面当作正式上线。
