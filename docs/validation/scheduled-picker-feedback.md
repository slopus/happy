# 定时任务选择反馈

用户反馈：执行机器列表没有鼠标悬停反馈，难以辨认是否选中。

## 原因与修改

原 `Choice` 同时给 `Item` 传入 `detail` 和自定义 `rightElement`，后者会隐藏当前值。`Item` 的 Web 行没有 hover 反馈，`selected` 也没有背景或勾选。

定时编辑器改用局部 `ScheduleChoice`，不改变全站 `Item`：

- 触发器独立显示字段名、当前值和展开状态；长值在行内省略。
- hover/pressed 使用当前主题的 `surfacePressed`，选中使用 `surfaceSelected`、加粗文字和勾选；选中项悬停仍保留选中背景。
- 焦点使用 `textLink` 边线；Web 提供 listbox/option、expanded 和显式 selected 语义。
- 选择后收起并返回触发器；重开可辨认当前项。方向键、Home/End、Enter、Space 可操作。
- 外点只关闭选择列表，不抢外部输入焦点；完整 Escape 按键不关闭父编辑弹窗，草稿保留。

## 验证

34 项定向检查通过：选择组件 DOM 回归、原编辑器草稿版本保护、日期草稿、主题映射和外点关闭 Hook。实际 DOM 回归曾暴露 RN Web 未将 `accessibilityState.selected` 转为 `aria-selected`，已显式补齐并保持该断言。

Ego 验证直接渲染源码组件、真实 React Native Web、Unistyles Web runtime 和主题包的隔离页面：

| 场景 | 结果 |
| --- | --- |
| 明亮主题，普通/hover/selected | 背景可区分，选中项有勾选，当前值可读 |
| `ginghamDark`，selected + hover | 选中背景、加粗和勾选保留，交互边线来自当前主题 |
| 620px 窄屏与长机器名 | 触发值省略、展开选项换行可读，没有横向溢出 |
| 选择、重开、键盘选择 | 当前值更新且提交一次，选中语义正确 |
| 外点与 Escape | 子列表关闭，输入焦点、父弹窗和草稿保留 |

本页记录组件级证据。正式完整编辑器验收与发布由对应交付记录维护；没有以隔离页面替代正式入口或 Android 真机验收。
