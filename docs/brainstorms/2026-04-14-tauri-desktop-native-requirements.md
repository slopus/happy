---
date: 2026-04-14
topic: tauri-desktop-native
---

# Tauri 桌面端原生体验

## Problem Frame

Happy 目前通过 Expo web 导出 + Tauri 打包的方式可以运行为桌面应用，已有基本的 Tauri 配置、HTTP plugin、平台检测（`__TAURI_INTERNALS__`）和 tablet 适配的双栏布局（SidebarNavigator + permanent drawer）。但缺少原生桌面能力：没有系统托盘、没有原生通知、安全存储用的是 localStorage、没有桌面快捷键。项目已有 `docs/layout-core.md` 定义了详细的三栏桌面布局方案。需要在此基础上补全原生能力，将现有 web 套壳升级为真正的桌面客户端。

## User Flow

```
┌──────────────────────────────────────────────────────────────────┐
│                        首次启动                                  │
│                                                                  │
│  安装 → 启动 → 账户创建/恢复 → 主界面（三栏布局）               │
│                    │                     │                        │
│                    ├─ QR 扫码（手机扫桌面）                      │
│                    └─ 手动输入密钥                                │
│                                                                  │
├──────────────────────────────────────────────────────────────────┤
│                        日常使用                                  │
│                                                                  │
│  开机自启 → 托盘常驻 → 收到通知 → 点击打开窗口                  │
│       │                    │                                     │
│       │              ┌─────┴──────────┐                          │
│       │              │  权限请求通知   │                          │
│       │              │  会话完成通知   │                          │
│       │              │  错误/异常通知  │                          │
│       │              └────────────────┘                          │
│       │                                                          │
│       └─ 关闭窗口 → 缩小到托盘（继续收通知）                    │
│                                                                  │
├──────────────────────────────────────────────────────────────────┤
│              三栏布局（遵循 layout-core.md）                      │
│                                                                  │
│  ┌──────────────┬──────────────────────┬────────────────┐       │
│  │  SidebarView  │       Center         │  ContextPanel  │       │
│  │   ~300px      │    flex:1 (~840px)   │    ~300px      │       │
│  │              │                      │                │       │
│  │  Sessions    │  [ChatHeader]        │  [Changed|All] │       │
│  │  ┌────────┐  │  [ChatList]          │  M auth.ts     │       │
│  │  │● fix.. │  │  [AgentInput]        │  M routes.ts   │       │
│  │  │  refac.│  │                      │  A helpers.ts  │       │
│  │  └────────┘  │                      │                │       │
│  │              │                      │                │       │
│  │  [+New]      │                      │  [Diff viewer] │       │
│  └──────────────┴──────────────────────┴────────────────┘       │
│                                                                  │
│  Cmd/Ctrl+0 → Zen 模式（隐藏两侧面板）                          │
│  Cmd/Ctrl+K → 命令面板                                          │
│  Cmd/Ctrl+N → 新建会话                                          │
└──────────────────────────────────────────────────────────────────┘
```

## Requirements

### P0 — MVP（最小可用桌面客户端）

**平台检测与桌面布局基础**
- R1. 提取现有内联 Tauri 检测逻辑（`_layout.tsx` 中已有 `__TAURI_INTERNALS__` 检查）为共享工具函数（`isTauri()`, `isDesktop()`），放入 `utils/platform.ts`，与现有 `isRunningOnMac()`、`Platform.OS === 'web'` 体系集成
- R2. 对需要原生能力的模块（通知 R7、安全存储 R9、托盘 R3-R5、快捷键 R12），通过运行时 `isTauri()` 检测分发 Tauri API；其他模块使用 web fallback。在 Tauri 环境下条件绕过 expo-notifications 初始化（`_layout.tsx` 中无条件导入会在 Tauri webview 中失败）
- R13. 三栏布局遵循 `docs/layout-core.md` 方案：SidebarView(~300px 会话列表) + Center(flex:1 聊天区) + ContextPanel(~300px 右侧文件/diff 面板)。替换 `expo-router/drawer` 为自定义 `flexDirection:'row'` 布局。包含 Zen 模式（Cmd+0 隐藏两侧面板）
- R16. `SidebarNavigator` 中的 `showPermanentDrawer` 条件需增加 `isTauri()/isDesktop()` 判断（当前 `useIsTablet()` 基于屏幕对角线英寸计算，在 Tauri 默认 800x600 窗口下返回 false，会隐藏侧边栏）。桌面端始终显示三栏布局，不依赖 tablet 检测
- R24. 定义 Tauri webview 安全策略：在 `tauri.conf.json` 中配置限制性 CSP（当前设为 null）；在 Tauri v2 capability 文件中定义最小权限，仅允许所需 plugin（notification、tray、updater 等），显式拒绝 file system、shell 等危险能力

**系统托盘与窗口管理**
- R3. 系统托盘图标常驻，显示连接状态（在线/离线），右键菜单包含：显示窗口、活跃会话列表（最多 5 个，按最近活跃排序，点击恢复窗口并导航）、新建会话、退出
- R4. 关闭窗口时缩小到托盘而非退出应用，托盘双击恢复窗口
- R5. 窗口状态持久化（尺寸、位置），关闭窗口时同步写入，下次启动时恢复

**原生通知**
- R7. 使用 Tauri notification plugin 发送原生桌面通知，覆盖：会话权限请求、会话完成/错误、好友请求。窗口前台时抑制系统通知（使用应用内 toast）。同一会话 5s 内合并通知
- R8. 点击通知跳转到对应会话/页面。目标已不存在时 fallback 到首页

**安全存储**
- R9. 认证凭据（token、secret key）存储到 OS 级安全存储（macOS Keychain、Windows Credential Manager、Linux Secret Service），替代 localStorage。首次升级启动时自动从 localStorage 迁移凭据到安全存储，成功后删除 localStorage 条目

**功能验证**
- V1. 验证所有核心工作流在 Tauri webview 中正常运行：会话管理、消息交互、文件浏览、好友系统、Artifacts、设置（由于 Expo web 导出已在 Tauri 中运行，大部分应已可用，需逐项确认）
- V2. 验证 QR 认证流在桌面端可用：桌面展示 QR 供移动端扫描（复用现有 `authQRStart.ts` 逻辑），手动密钥输入作为备选

**跨平台构建**
- R21. 支持 macOS、Windows、Linux 三个平台
- R23. 各平台构建产物：macOS(.dmg/.app)、Windows(.msi/.exe)、Linux(.AppImage/.deb)

### P1 — 完善桌面体验

- R6. 开机自启（用户可在设置中开关）
- R11. 注册 `happy://` 协议处理器。定义路由表：`happy://session/{id}`、`happy://terminal/connect?token=xxx`。深度链接 payload 必须验证路由白名单，触发认证操作的链接需确认用户已登录。无效路径 fallback 到首页
- R12a. 应用内快捷键：扩展现有 `useGlobalKeyboard` hook，添加 Cmd+N（新建会话）、Cmd+K（命令面板）等。在 Tauri webview 中已可工作
- R12b. 单一全局唤醒快捷键（如 Cmd+Shift+H），通过 `tauri-plugin-global-shortcut` 注册为 OS 级快捷键，用于从其他应用快速唤起 Happy 窗口。不注册 Cmd+K/N/1-9 为全局快捷键（会与 IDE、浏览器等冲突）
- R15. ContextPanel（右侧面板）根据 layout-core.md 实现：Changed/All 文件列表、diff 查看器
- R22. macOS 支持原生窗口控件（traffic lights）和暗色标题栏

### P2 — 增强功能

- R10. 自动更新：v1 通过 GitHub Releases 分发，用户手动下载。后续集成 Tauri updater plugin（需要后端 endpoint 和签名基础设施）
- R14. SidebarView 和 ContextPanel 宽度可拖拽调整（layout-core.md P1/P2）
- R18. 语音功能通过 WebRTC 在 Tauri webview 中运行。Linux WebKitGTK 如不支持 WebRTC，该平台优雅降级（禁用语音功能，显示提示）
- R20. CLI 终端连接在桌面端通过 `happy://terminal/connect` deep link 完成（依赖 R11）

## Success Criteria

- 桌面端可以完成所有核心工作流（创建会话、查看消息、审批权限、管理好友和 artifacts）
- 关闭窗口后应用继续在托盘运行，收到权限请求时弹出原生通知
- 认证凭据存储在 OS 安全存储中，localStorage 中无残留
- 三栏布局（layout-core.md）在 1280px+ 窗口下正常展示，包含 Zen 模式
- 窗口尺寸/位置在重启后恢复
- Tauri CSP 和 capability 配置限制了 webview 权限
- macOS、Windows、Linux 三个平台均可构建和运行

## Scope Boundaries

- **不包含** 应用商店内购（RevenueCat 不适用于桌面端独立分发）
- **不包含** 触觉反馈（桌面无硬件支持）
- **不包含** 摄像头 QR 扫码（桌面端只展示 QR 供手机扫，不扫码）
- **不包含** 推送令牌注册（APNs/FCM 不适用，用 Tauri 原生通知替代）
- **不包含** 移动端 dev pages 迁移
- **不包含** 对现有移动端/web 端代码的破坏性修改（Tauri 特有逻辑通过 `isTauri()` 条件分支，web 路径保持不变）

## Key Decisions

- **构建流程沿用 Expo web → Tauri 打包**：不引入新的前端构建流程，保持与现有 web 版共享代码的优势。桌面特有逻辑通过运行时平台检测分发，而非编译时条件编译
- **三栏布局以 `docs/layout-core.md` 为权威来源**：SidebarView(会话列表) + Center(聊天区) + ContextPanel(文件/diff)，替换 expo-router/drawer 为自定义 flex 布局。包含 Zen 模式。需求文档中的 R13 遵循该方案
- **Tauri Plugin 体系处理原生能力**：通知用 `tauri-plugin-notification`、托盘用 Tauri tray API、安全存储用 OS keychain（非 stronghold，因 R9 明确要求 OS 级安全存储）、深度链接用 `tauri-plugin-deep-link`
- **运行时检测而非文件后缀分发**：通过 `window.__TAURI_INTERNALS__`（Tauri v2 标准全局变量）运行时检测。桌面布局不依赖 `useIsTablet()` 的英寸计算，直接用 `isDesktop()` 判断
- **Webview 安全加固**：配置限制性 CSP 和最小权限 Tauri capability，防止 XSS 升级为原生 OS 访问（项目有 Mermaid XSS 修复先例 PR#678）
- **自动更新分阶段**：P0 不含自动更新，通过 GitHub Releases 分发。P2 再集成 Tauri updater

## Dependencies / Assumptions

- Tauri v2 (2.8.2) 的 webview 支持 WebRTC（macOS WebKit ✓、Windows WebView2/Chromium ✓、Linux WebKitGTK 待验证）
- Tauri plugin 生态在 v2 下稳定可用（notification、tray、deep-link）
- 现有 Socket.IO 实时同步和 libsodium 加密在 Tauri webview 中正常工作
- 当前 Cargo.toml 仅包含 `tauri-plugin-http` 和 `tauri-plugin-log`，需新增：notification、tray、deep-link、global-shortcut、autostart、window-state 等 plugin

## Outstanding Questions

### Resolve Before Planning
- (empty - all product decisions resolved)

### Deferred to Planning
- [Affects R18][Needs research] 验证 Tauri v2 各平台 webview 对 WebRTC 的支持情况，特别是 Linux WebKitGTK。在目标 Linux 发行版（Ubuntu 22.04/24.04、Fedora 39+）上运行 WebRTC probe 测试。如果失败，Linux 禁用语音功能
- [Affects R13][Technical] layout-core.md 的三栏布局替换 expo-router/drawer 为自定义 flex 布局的具体实现：如何保持 Expo Router 的导航状态管理，center 列内的路由切换方案
- [Affects R23][Technical] CI/CD 跨平台构建流水线设计（GitHub Actions 矩阵构建 + 签名/公证）
- [Affects R9][Technical] OS keychain 的跨平台集成方案：macOS 用 Security framework、Windows 用 Credential Manager API、Linux 用 libsecret。通过 Tauri Rust command 暴露给前端

## Next Steps

→ `/ce:plan` for structured implementation planning
