# 子代理详情侧栏主题与布局修复

## 问题与范围

桌面打开委派任务或原生子代理详情时，SessionView 直接替换 DesktopRightPanel，绕过照片皮肤的 readingWide / readingSolid、圆角裁切与宽度拖动手柄。详情虽然使用 surface/text/divider，并非写死颜色，但普通 surface 覆盖了宿主皮肤表面。

保留会话、右栏位置、任务/交接资料/结果及既有请求语义。桌面详情和普通右栏共用 DesktopRightPanelFrame，外壳持有唯一表面，详情内部透明；减少透明度沿宿主已有实色 token。compact / embedded 抽屉继续采用不透明主题 surface。

任务页复用 PanelTabs 的主题交互与键盘导航；返回按钮采用现有 40px 尺寸，状态与刷新同行，需求正文优先，角色/执行器/会话/任务标识集中为次要信息。UUID 可换行，不修改任务、结果、版本缓存、手动刷新或仅填入草稿的行为。

## 验证

- 相关组件、SessionView、主题回归共 131 项通过；App 完整 typecheck 通过。
- 独立源码 review 通过，Frame 背景、圆角、拖动手柄和非 resizable 回退均覆盖。
- 原正式会话复现了无 Frame、普通不透明 surface 和直角底边。
- 候选完整 App、隔离 PGlite/真实加密 RPC 与合成任务：详情打开、结果与任务切换、Home 键返回任务页通过，桌面无所测横向溢出。
- Gingham 深色真实外观设置：普通 surface、hover/pressed、selected 分别读回对应主题色；等待渲染稳定后验证，未用即时过渡采样代替最终色。
- 照片皮肤与上线后原会话验收结果记录于本机唯一发行报告。
- 额外 PR 前后截图已询问，用户尚未回复；未制作对照矩阵。必要浏览器关键步骤按宿主要求绑定 session/run/space/target 回传。

## 边界

本次无原生依赖、权限、包名或 runtime 变化，不需新 APK。浏览器窄屏与 OTA 制品不等于用户手机加载或原生触控验收。正式发布、来源与制品、当前设备结果由发行记录分别核验。
