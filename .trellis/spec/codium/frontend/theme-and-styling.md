# 主题与样式

## 主题是派生系统

主题输入定义在 sources/theme/types.ts，preset 在 presets.ts，derive.ts 从 accent、ink、surface、contrast、opaqueWindows、fonts 与 semanticColors 派生 60+ CSS custom properties。renderer 组件消费语义 token，不自行重复派生颜色。

packages/codium/design-system.md 是当前主题公式、token 映射和来源说明。修改系数或 token 时同步更新 derive.ts 测试与文档中的当前公式。

## CSS 组织

全局 token、Tailwind 基础和字体入口在 sources/index.css。组件样式与组件同名并列，例如 Composer.tsx/Composer.css、MainSidebar.tsx/MainSidebar.css。布局样式放 sources/app/layouts。

颜色使用：

    color: var(--color-text-foreground);
    background: var(--color-background-surface);
    border-color: var(--color-border);

不要在组件 CSS 直接写主题相关灰色、背景和 accent。只有语义色、品牌资产或设计系统明确列出的常量可保持 literal。

## 主题变化

主题应用必须同时更新 html 的 CSS variables、mode class、字体与窗口 opaque/vibrancy 行为。dark mode 的 accent 会经 deriveTokens 增亮，普通组件不应再次 color-mix。

新增 token 时：

1. 先确认现有语义 token 不足。
2. 在 types/derive 中提供 light/dark 一致定义。
3. 在 index.css 添加必要 alias。
4. 为端点 contrast 和自定义颜色增加 snapshot/单测。
5. 更新 design-system.md 的当前 token 表。

## 可访问性

交互组件保留 focus-visible、disabled、hover 和 active 状态。只靠颜色不足以表示错误、选中或 diff；沿用图标、文字与 semanticColors。不要用低 alpha 文本绕过派生的 secondary/tertiary token。
