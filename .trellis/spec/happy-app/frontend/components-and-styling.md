# 组件、文本与样式

## 组件复用顺序

设置、列表和详情页先检查 Item 与 ItemList；头像使用 Avatar；对话框使用 packages/happy-app/sources/modal，禁止直接使用 React Native Alert。真实实现见：

- packages/happy-app/sources/components/Item.tsx
- packages/happy-app/sources/components/ItemList.tsx
- packages/happy-app/sources/components/Avatar.tsx
- packages/happy-app/sources/modal/index.ts

异步按钮和表单操作优先通过 useHappyAction 统一处理重复点击、loading 和 HappyError，见 packages/happy-app/sources/hooks/useHappyAction.ts。

## 国际化

所有可翻译的用户可见字符串使用 t(...)。先在 common 查复用键，再按页面或领域命名。动态文案使用带类型参数的函数。

    import { t } from '@/text';

    const title = t('settings.title');
    const age = t('time.minutesAgo', { count: 5 });

新增语言键前先读 sources/text/translations 的现有结构，并同时更新 sources/text/_all.ts 所列的每种语言。sources/app/(app)/dev 下的开发页可以保留直接文本。

## Unistyles

组件样式放在组件文件末尾或紧邻实现，并通过 react-native-unistyles 的 StyleSheet.create 使用主题 token。状态变化优先使用既有 variants 或样式数组，不复制主题颜色常量。

    const styles = StyleSheet.create((theme) => ({
        container: {
            backgroundColor: theme.colors.surface,
            paddingHorizontal: theme.margins.md,
        },
    }));

React Native 与 Reanimated 组件可直接接收生成的 style。expo-image 是明确例外：宽高使用 inline style，tintColor 作为组件属性，其他视觉样式才走样式表。现有例子见 packages/happy-app/sources/components/Avatar.tsx。

## 响应式与交互

- 全屏 ScrollView 和内容容器使用 components/layout.ts 的宽度约束。
- 热键统一经 useGlobalKeyboard；它只在 Web 生效。
- 互斥异步操作使用 sources/utils/lock.ts 的 AsyncLock。
- 页面 header 保持可见；确需隐藏时沿用会话等已有沉浸式页面模式。

## 反例

- JSX 中直接写生产用户文案。
- 用 Alert.alert 绕过 Modal。
- 新建一个只服务单页、功能等价于 Item 的列表行组件。
- 在样式里硬编码已有 theme.colors 对应的颜色。
