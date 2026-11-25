# PC Web 视频使用播放器自带控件

用户要求移除视频播放器下方重复的下载区域。Web 不再渲染文件名、大小、保存按钮及保存进度/结果；原生 App 保留原来的保存流程。播放加载失败提示仍保留。

## 实现与审查

- `FileView` 仅在非 Web 平台渲染视频保存区域；播放源、播放器参数、浏览器 controls 和原生保存实现未改变。
- 自查最终 diff：变更限于该平台展示条件及现有回归测试，无原生依赖、权限、runtime 或主题变化。
- 当前账号未配置委派角色，未执行独立 Agent 评审；自查不记为独立评审。

## 本地验证

在独立工作树执行：

```sh
pnpm --filter happy-app exec vitest run sources/components/tools/views/FileView.test.tsx sources/components/tools/views/MediaAttachmentPlayer.web.test.tsx sources/utils/otaRuntimeConfig.test.ts
pnpm --filter happy-app typecheck
git diff --check
```

39 项测试及类型检查通过。现有测试覆盖 Web 用户/生成视频无附加区域、加载中无保存入口、原生保存的进度/取消/重试/共享下载/资源释放，以及浏览器鉴权播放资源释放。

## 验证边界

源码与组件测试不代替正式页面或用户当前设备验收。发布、正式视频播放与截图选择的实际结果由 Release OPS 本次交付记录维护。未改变手机保存功能，不把本次 PC 展示改动描述为解决历史手机视频保存故障。
