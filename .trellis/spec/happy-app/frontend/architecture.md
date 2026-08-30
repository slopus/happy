# 架构与目录

## 目录职责

- sources/app：Expo Router 页面与布局。业务页面放在 sources/app/(app)。
- sources/components：跨页面 UI；复杂领域组件继续按现有子目录归类。
- sources/hooks：可复用、非平凡的 React 行为。复杂 hook 应有说明其职责的注释。
- sources/sync：HTTP、Socket.IO、加密、归一化、reducer 与持久化。
- sources/auth：挑战应答、二维码和密钥存储。
- sources/text：类型化翻译目录。
- sources/utils：无 UI 所有权的纯函数；平台差异可用 .web.ts 等并列实现。
- src-tauri：macOS 包装层，不承载 React 业务状态。

真实例子：
- packages/happy-app/sources/utils/readFileBytes.ts 与 readFileBytes.web.ts 展示平台文件分离。
- packages/happy-app/sources/realtime/RealtimeVoiceSession.web.tsx 展示 Web 专用实现。
- packages/happy-app/sources/app/(app)/_layout.tsx 集中声明多数页面标题和 header 行为。

## 路由

使用 expo-router 的 Stack、router 和文件路由 API，不从 react-navigation 直接建立另一套路由。能静态表达的 headerTitle、headerShown、headerBackTitle 放在 _layout.tsx；只有依赖页面运行态的数据才在页面内动态设置。

完整页面通常以 React.memo 包装。全屏内容同时考虑窄屏与桌面宽度，复用 packages/happy-app/sources/components/layout.ts 中的约束，不单独发明固定宽度。

## 平台优先级

iOS、Android 是主要运行面，Web 是同一应用的次级运行面，macOS 由 Tauri 承载。只有平台 API 或交互确实不同才增加 .web.ts、Platform.select 或 Tauri 分支；共享业务规则保留一份。

## 反例

- 在页面里直接 new Socket.IO 客户端并维护 sessions 副本。
- 为单个页面引入 react-navigation 风格的导航容器。
- 把临时脚本散落在 sources 根目录；非单元测试的临时实验使用 sources/trash。
- 为旧消息格式加兼容分支，除非任务明确要求协议兼容。
