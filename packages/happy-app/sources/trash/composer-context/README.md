# 输入框分类浮层验收

运行 `node sources/trash/composer-context/build.mjs`，使用 Ego 浏览器打开其本地入口。
这是实际 MessageComposer、MultiTextInput.web、ComposerContextPicker、ComposerContextHost.web 和 RN Web 的受控集成：插件、会话、站点卡片、文件查询及文件选择器使用合成数据/替身，不接真实账号或执行器。图标与主题边界由 boundaries.tsx 提供。完整 App 的 Unistyles、生产数据和原生端未在此证明。

## Case 与通过标准

| Case | 路径 | 通过标准 |
| --- | --- | --- |
| C1 | 首页／会话输入 @ | 即使没有文件也立即显示全部、文件、插件、站点、最近对话分类 |
| C2 | 空草稿或已有草稿点击 + | 打开同一浮层，不更改草稿，不直接调用文件选择器 |
| C3 | 插件、站点、最近会话 | 各类型筛选后可选；插入可读引用或站点链接，保留原草稿两侧内容 |
| C4 | 上传文件／工作区文件 | 仅点击上传后调用选择器一次；文件路径插入原有 @path 语法 |
| C5 | 搜索与键盘 | 普通 Enter/Tab 选中、方向键移动、Escape 关闭并还原焦点；IME composing/229 不选中 |
| C6 | 小桌面窗口与裁切祖先 | 900×700 下浮层在视口内；外层 overflow:hidden 不裁切 portal 浮层；外部点击关闭且不抢焦点 |

2026-11-14：上述真实组件/合成数据路径已由 Ego 实测，包含插件/站点点击、搜索会话后 Enter、IME、上传一次、文件点击与键盘选择。桌面菜单行高34px，最多400px高；原生触控行高44px。首页没有工作目录时保留上传，不伪造工作区文件。

## 数据与能力边界

- 插件只显示账号目录中已安装项；插入名称及公共 plugin ID，不附带配置/密钥，也不自动安装或执行插件。
- 最近对话排除当前、归档及 Personal 独立会话，按实际会话消息时间排序。搜索覆盖全部已加载的候选，再限制显示数量；引用不自动复制会话正文。
- Happy 目前没有独立的已收藏站点库；站点来自已加载会话中的 ready 预览卡片，排除过期、失败、非HTTP(S)和URL自带凭据项。不会扫描浏览器历史或创建站点。
- 文件查询按用户打开文件分类或输入搜索触发，异步返回使用 effect 清理拒绝过期请求。插件目录复用中央事件订阅，不新增轮询。
- 前后对照截图已询问，用户尚未回复；未制作 PR 对照图。浏览器操作的必需关键步骤帧已通过当前 Happy 会话的 Skills 入口报告。未要求视频，本次无视频产物。

## 自动回归

`pnpm exec vitest run sources/components/MessageComposer.context.test.tsx sources/components/MessageComposer.paste.test.tsx sources/components/MessageComposer.screenshot.test.tsx sources/components/autocomplete`

91项通过。完整 `pnpm exec tsc --noEmit --incremental false` 通过；Expo Web export 通过。独立代码评审及组件静态图评审通过，生产账号、完整App视觉及原生端留待后续验收。
