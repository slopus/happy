# 会话输入框毛玻璃

用户希望继续参考 T3 Code，让已悬浮的 Web 会话输入框具备背景柔化效果。
基线为 PR923 的 `42785de5fa5a33cb4382c456639d0bb07e84fe9d`，沿用原输入框、字号、圆角、尺寸与操作位置。

## 参考与实现

T3 Code 固定版本 `f0d45119216310837bf28b08f0f0671cc024a048`：

- [玻璃参数](https://github.com/pingdotgg/t3code/blob/f0d45119216310837bf28b08f0f0671cc024a048/apps/web/src/index.css#L119)：80% 背景，浅色 `blur(12px) saturate(1.14)`，深色 `blur(16px) saturate(1.08)`。
- [ComposerSurface](https://github.com/pingdotgg/t3code/blob/f0d45119216310837bf28b08f0f0671cc024a048/apps/web/src/components/chat/ComposerSurface.tsx#L21)：独立半透明背景层，并为不支持标准和 WebKit 背景滤镜的浏览器保留实色。

Paws 采用同组轻毛玻璃参数，颜色由当前 `theme.colors.input.background` 派生，边线使用 `theme.colors.divider`。
只柔化输入框后的背景，不对整个输入框设置 opacity，文字和控件保持实色。
材质由 Web hook 接入现有 panel；保留 `overflow: visible`，主要弹层沿原有 Portal/Modal 打开。
复用 `useReducedTransparency`，减少透明度或提高对比度实时回退实色；不支持滤镜时也保留实色。
首页输入框和 Native 使用原样式。无新设置、图标、原生依赖或 runtime 变化；共享接入按既有 CI 保守发布 OTA。

## 验证范围

| Case | 通过标准 |
| --- | --- |
| GLASS-THEME | 浅色、ginghamDark 与照片皮肤沿当前主题取色，背景有模糊，文字未整体变透明 |
| GLASS-FALLBACK | 系统减少透明度/高对比度变化、无标准或仅 WebKit 支持时正确回退或启用 |
| GLASS-INPUT | 可编辑输入；模型、权限和 @ 菜单可见可退出；不改变草稿和滚动布局 |
| GLASS-SCOPE | 首页和原生样式保持；不添加轮询 |

Web hook 回归包含当前主题切换、系统偏好实时变化、原生及首页不启用、WebKit 单独支持与无滤镜回退；先在未实现材质时观察到透明度与 WebKit 两个失败，再实现通过。
复用 MessageComposer 上下文/输入/粘贴、overlay 与 OTA runtime 契约验证。正式浏览器与分发结果归本任务 Release OPS 唯一记录。

截图状态沿当前会话的待回复选择，尚未采集；不把沉默写为已确认不需要。
