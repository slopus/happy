---
title: "feat: Native Tauri Desktop Experience"
type: feat
status: active
date: 2026-04-14
origin: docs/brainstorms/2026-04-14-tauri-desktop-native-requirements.md
---

# feat: Native Tauri Desktop Experience

## Overview

Transform Happy's existing Tauri desktop build from a web wrapper into a native desktop application with system tray, native notifications, OS keychain storage, three-column layout (per `docs/layout-core.md`), and cross-platform support (macOS/Windows/Linux). The current Tauri setup only has HTTP and Log plugins — all native desktop capabilities are net new.

## Problem Frame

Happy's Tauri build runs the Expo web export in a native window but lacks desktop-native capabilities. Developers working on desktop need: background persistence via system tray, native notifications for permission requests, secure credential storage beyond `localStorage`, and a three-column layout optimized for wide screens. The project already has `docs/layout-core.md` specifying the target layout and a minimal Tauri v2 (2.8.2) setup to build upon. (see origin: `docs/brainstorms/2026-04-14-tauri-desktop-native-requirements.md`)

## Requirements Trace

**P0 — MVP:**
- R1. Centralized `isTauri()` / `isDesktop()` platform detection
- R2. Runtime platform dispatch with expo-notifications conditional bypass
- R3. System tray with connection status and session list
- R4. Close-to-tray behavior
- R5. Window state persistence
- R7. Native desktop notifications via Tauri plugin
- R8. Notification click-to-navigate
- R9. OS keychain secure storage with localStorage migration
- R13. Three-column layout per `layout-core.md`
- R16. Desktop layout bypass of `useIsTablet()` detection
- R21/R23. Cross-platform builds (macOS/Windows/Linux)
- R24. CSP and Tauri capability security hardening
- V1. Feature verification in Tauri webview
- V2. QR auth flow verification

**P1 — Deferred to future plan:**
R6, R11, R12a/b, R15, R22

**P2 — Deferred to future plan:**
R10, R14, R18, R20

## Scope Boundaries

- No in-app purchases (RevenueCat N/A on desktop)
- No haptic feedback
- No camera QR scanning (desktop shows QR for mobile to scan)
- No APNs/FCM push tokens (replaced by Tauri notifications)
- No dev pages migration
- No breaking changes to existing mobile/web code paths
- P1/P2 items are out of scope for this plan

## Context & Research

### Relevant Code and Patterns

| File | Role | Relevance |
|------|------|-----------|
| `sources/utils/platform.ts` | Platform detection (`isRunningOnMac()`) | R1: Add `isTauri()`, `isDesktop()` here |
| `sources/app/_layout.tsx` | Root layout, notification init, inline `isTauri` check (L108) | R2: Conditional bypass, R1: extract check |
| `sources/components/SidebarNavigator.tsx` | Drawer layout, `showPermanentDrawer = isTablet` | R16: Add desktop override, R13: replace Drawer |
| `sources/components/SidebarView.tsx` | Left panel content (sessions, tabs, FAB) | R13: Keep as-is in three-column |
| `sources/components/layout.ts` | Width constraints (`maxWidth=800` on web) | R13: Remove maxWidth in three-column mode |
| `sources/auth/tokenStorage.ts` | Credentials in `localStorage` for web | R9: Add Tauri keychain path + migration |
| `sources/sync/pushRegistration.ts` | Push disabled for `Platform.OS==='web'` | R7: Add Tauri notification path |
| `sources/hooks/useGlobalKeyboard.ts` | Web keydown listener (Cmd+K only) | Reference for P1 shortcut work |
| `src-tauri/Cargo.toml` | Only `tauri-plugin-http` + `tauri-plugin-log` | Add all new plugins |
| `src-tauri/src/lib.rs` | Minimal 17-line Rust setup | Add tray, keychain commands |
| `src-tauri/tauri.conf.json` | CSP=null, 800x600 window | R24: Configure CSP, resize defaults |
| `src-tauri/capabilities/default.json` | Only `core:default` + `http:default` | R24: Add plugin permissions |
| `docs/layout-core.md` | Three-column layout spec | R13: Authoritative layout design |

### Institutional Learnings

- Font loading in Tauri requires fire-and-forget pattern (existing workaround in `_layout.tsx` L107-163)
- `expo-notifications` import at module scope will crash in Tauri webview — must be conditional
- `isRunningOnMac()` only detects Mac Catalyst (iOS), NOT Tauri on macOS
- `sentFrom` field in `sync.ts` sends `"web"` for Tauri — should eventually be `"desktop"`
- Project has prior XSS vulnerability (Mermaid XSS, PR#678) — CSP hardening is justified
- No `docs/solutions/` knowledge base exists in this project

## Key Technical Decisions

- **Replace `expo-router/drawer` with custom flex layout for desktop only:** The current `<Drawer>` component from expo-router supports two-panel (sidebar + content) but not three-panel. `layout-core.md` specifies replacing it with `flexDirection:'row'` wrapper containing SidebarView, Center (`<Slot/>`), and ContextPanel. Mobile/tablet continues using the existing Drawer. The decision point is `isDesktop()` in `SidebarNavigator.tsx`. (see origin: Key Decisions — layout-core.md as authority)

- **OS keychain via Tauri Rust commands, not stronghold:** R9 requires OS-level secure storage. `tauri-plugin-stronghold` is an encrypted file store, not OS keychain. Custom Rust `#[tauri::command]` functions will wrap platform-specific keychain APIs (macOS Security framework, Windows Credential Manager, Linux libsecret). JS-side calls via `invoke()`. (see origin: Key Decisions — OS keychain)

- **Notification bridge pattern:** Tauri notifications are Rust-side. Frontend will call `invoke('send_notification', {...})` and listen for notification-click events via Tauri event system (`listen('notification-clicked', ...)`). This replaces the expo-notifications listener pattern in `_layout.tsx`. (see origin: R7, R8)

- **CSP allowlist approach:** Allow `'self'`, the configured server URL (`EXPO_PUBLIC_HAPPY_SERVER_URL`), WebSocket connections (`wss:`), and font resources. Block inline scripts. Tauri v2 capability file restricts IPC to only the plugins used. (see origin: R24)

- **Window defaults updated:** Change default Tauri window from 800x600 to 1280x800 with `minWidth: 900`, `minHeight: 600`. This ensures three-column layout is visible on launch. (see origin: R13)

## Open Questions

### Resolved During Planning

- **Q: How does Center column handle route switching in three-column?** Resolution: `<Slot/>` from expo-router renders the current route in the Center column. SidebarView and ContextPanel persist outside the Slot. When navigating to non-session routes (settings, friends, artifacts), they render inside the Slot, replacing the chat view. This is the standard expo-router layout pattern.

- **Q: How to communicate tray state from JS to Rust?** Resolution: JS calls `invoke('update_tray_status', { online, sessions })` whenever connection state or session list changes. Rust-side rebuilds the tray menu. Tray menu actions (show window, navigate to session, new session, quit) emit Tauri events that JS listens for.

- **Q: Which keychain crate for Rust?** Resolution: Use the `keyring` crate (cross-platform: macOS Keychain, Windows Credential Manager, Linux Secret Service). Simpler than direct platform APIs. Service name: `com.slopus.happy`.

### Deferred to Implementation

- Exact CSP directive string (depends on all resource URLs the app loads at runtime)
- Linux WebKitGTK WebRTC support verification (P2, not blocking P0)
- ContextPanel content implementation details (P1 scope, this plan only creates the shell)

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

### Three-Column Layout Architecture

```
┌─ DesktopLayout (flexDirection:'row') ──────────────────────────────┐
│                                                                     │
│  ┌─ SidebarView ─┐  ┌─ Slot (expo-router) ─┐  ┌─ ContextPanel ─┐ │
│  │   width:300    │  │     flex:1            │  │   width:300    │ │
│  │                │  │                       │  │                │ │
│  │  [Existing     │  │  Routes render here:  │  │  [Shell only   │ │
│  │   component,   │  │  - session/[id]       │  │   in P0.       │ │
│  │   unchanged]   │  │  - settings/*         │  │   Placeholder  │ │
│  │                │  │  - friends/*          │  │   with file    │ │
│  │                │  │  - artifacts/*        │  │   list from    │ │
│  │                │  │  - new/               │  │   git status]  │ │
│  └────────────────┘  └───────────────────────┘  └────────────────┘ │
│                                                                     │
│  Zen mode (Cmd+0): hides SidebarView + ContextPanel, Center=100%  │
└─────────────────────────────────────────────────────────────────────┘

Decision point: SidebarNavigator.tsx
  if (isDesktop()) → render DesktopLayout
  else             → render existing Drawer (mobile/tablet unchanged)
```

### Platform Dispatch Architecture

```
isTauri() check (window.__TAURI_INTERNALS__)
  │
  ├─ Notifications:  isTauri() ? invoke('send_notification') : expo-notifications
  ├─ Token storage:  isTauri() ? invoke('keychain_*')        : localStorage (web) / SecureStore (native)
  ├─ Tray/Window:    isTauri() ? Tauri window/tray APIs      : N/A
  └─ Layout:         isDesktop() ? DesktopLayout              : Drawer
```

### Rust Backend Architecture

```
lib.rs
  ├─ Plugins (P0): http, log, notification, window-state
  │   (P1, future plan: global-shortcut, autostart, deep-link)
  ├─ Tray: TrayIconBuilder with menu (show, sessions, new, quit)
  ├─ Commands:
  │   ├─ keychain_get(service, key) -> Option<String>
  │   ├─ keychain_set(service, key, value)
  │   ├─ keychain_delete(service, key)
  │   ├─ send_notification(title, body, route)
  │   └─ update_tray_status(online, sessions[])
  └─ Events:
      ├─ tray-action: { action: "show" | "new-session" | "navigate", sessionId? }
      └─ notification-clicked: { route }
```

## Implementation Units

### Phase 0: Spike (验证核心架构假设)

- [ ] **Unit 0: Three-Column Layout Prototype**

  **Goal:** 验证 expo-router `<Slot/>` 在自定义 flex 容器中工作，不依赖 Drawer navigator 上下文

  **Requirements:** R13 (验证可行性)

  **Dependencies:** None — 独立 spike，可丢弃

  **Files:**
  - Modify: `packages/happy-app/sources/components/SidebarNavigator.tsx` (临时修改，spike 后可回退)

  **Approach:**
  - 在 `SidebarNavigator.tsx` 中临时添加一个 `flexDirection:'row'` 容器，包含 `<SidebarView />`、`<Slot />`、一个占位 `<View>`
  - 在 `pnpm tauri:dev` 中验证：(1) 路由在 Slot 中正常渲染, (2) 导航状态在路由切换时保持, (3) 浏览器前进/后退工作, (4) SidebarView 在路由切换时不重新挂载
  - 测量渲染性能（三栏布局下滚动是否流畅）
  - 验证 Zen 模式可行性（动态隐藏侧栏，Slot 自动填充）
  - **如果 Slot 在 Drawer 外不工作**：fallback 方案是保留 Drawer 但将 `drawerType` 设为 `permanent`，在主内容区内部做水平分割（Slot 内容 + ContextPanel）。这种方式不需要移除 Drawer，但 ContextPanel 会在 Slot 内部而非外部

  **Test expectation:** 手动验证 — 这是一次性 spike，不需要自动化测试

  **Verification:**
  - 在 Tauri 窗口中看到三栏布局
  - 点击 SidebarView 中的 session 后，Center 列更新为 session 视图
  - 导航到 Settings/Friends 后，SidebarView 保持不变
  - 如果验证失败，记录失败原因并切换到 fallback 方案
  - **Gate:** 只有 spike 成功后才进入 Phase 1

---

### Phase 1: Foundation

- [ ] **Unit 1: Platform Detection Utilities**

  **Goal:** Centralize Tauri/desktop detection into shared utilities

  **Requirements:** R1

  **Dependencies:** None — this is the foundation for all subsequent units

  **Files:**
  - Modify: `packages/happy-app/sources/utils/platform.ts`
  - Modify: `packages/happy-app/sources/app/_layout.tsx` (remove inline isTauri check, use shared utility)
  - Test: `packages/happy-app/sources/utils/platform.test.ts`

  **Approach:**
  - Add `isTauri()`: checks `Platform.OS === 'web' && typeof window !== 'undefined' && (window as any).__TAURI_INTERNALS__ !== undefined`
  - Add `isDesktop()`: returns `isTauri() || isRunningOnMac()` (covers both Tauri and Mac Catalyst)
  - Add `useIsDesktop()` hook (reactive, re-evaluates on dimension changes — though `isTauri()` is static)
  - Export from `platform.ts` alongside existing `isRunningOnMac()`
  - Replace inline check in `_layout.tsx` L108 with imported `isTauri()`

  **Patterns to follow:**
  - `isRunningOnMac()` pattern in same file for naming and export style
  - `useIsTablet()` hook pattern in `responsive.ts` for the hook variant

  **Test scenarios:**
  - Happy path: `isTauri()` returns true when `__TAURI_INTERNALS__` is defined on window and Platform.OS is 'web'
  - Happy path: `isTauri()` returns false when `__TAURI_INTERNALS__` is undefined
  - Happy path: `isDesktop()` returns true for Tauri environment
  - Edge case: `isTauri()` returns false on native platforms (Platform.OS !== 'web') even if __TAURI_INTERNALS__ somehow exists
  - Edge case: `isDesktop()` returns true for Mac Catalyst (isRunningOnMac() = true) even when not Tauri

  **Verification:**
  - `pnpm typecheck` passes
  - All tests pass
  - `_layout.tsx` no longer contains inline `__TAURI_INTERNALS__` check

---

- [ ] **Unit 2: Tauri Plugin Scaffolding**

  **Goal:** Install all required Tauri plugins in Rust and configure capabilities

  **Requirements:** R24 (capabilities), prerequisite for R3/R7/R9

  **Dependencies:** None (Rust-side only)

  **Files:**
  - Modify: `packages/happy-app/src-tauri/Cargo.toml`
  - Modify: `packages/happy-app/src-tauri/src/lib.rs`
  - Modify: `packages/happy-app/src-tauri/capabilities/default.json`
  - Modify: `packages/happy-app/src-tauri/tauri.conf.json` (CSP, window defaults)
  - Create: `packages/happy-app/src-tauri/capabilities/desktop.json` (if separate capability file needed)

  **Approach:**
  - Add Cargo dependencies: `tauri-plugin-notification`, `tauri-plugin-window-state`, `keyring` (for OS keychain). P1 plugins (global-shortcut, autostart, deep-link) deferred to future plan
  - Note: Tauri v2 tray is in core `tauri` crate (`tauri::tray` module). Window state requires `tauri-plugin-window-state` (separate plugin)
  - Register plugins in `lib.rs` builder chain
  - CSP 审计步骤: (1) grep 所有 `fetch()`、WebSocket、image、font、script 加载，记录所有外部域名, (2) 基于审计结果起草 CSP 指令, (3) 在 `pnpm tauri:dev` 中测试 CSP: 验证字体加载、API 调用成功、WebSocket 连接、无 CSP violation
  - Update `tauri.conf.json`: 基于审计结果设置 CSP（预期允许: `'self'`, API server origin, `wss:`, font CDN if any; 阻止: inline scripts, eval），change default window to 1280x800, set `minWidth: 900` / `minHeight: 600`
  - Update capabilities: add permissions for notification and window-state. Keep http permissions. Explicitly do NOT add fs, shell, or other dangerous capabilities. P1 capability additions (global-shortcut, autostart, deep-link) deferred to future plan

  **Patterns to follow:**
  - Existing `tauri_plugin_http::init()` and `tauri_plugin_log::Builder` patterns in `lib.rs`

  **Test scenarios:**
  - Happy path: `pnpm tauri:dev` starts successfully with all plugins loaded
  - Happy path: Tauri dev window opens at 1280x800 (not 800x600)
  - Error path: Verify `csp` in tauri.conf.json blocks inline script execution (test with a manual `<script>` injection in dev tools)

  **Verification:**
  - `cargo build` succeeds in `src-tauri/`
  - `pnpm tauri:dev` launches with new window size
  - Browser console shows no CSP violations for normal app operation

---

- [ ] **Unit 3: Conditional expo-notifications Bypass**

  **Goal:** Prevent expo-notifications from crashing in Tauri webview

  **Requirements:** R2

  **Dependencies:** Unit 1 (isTauri)

  **Files:**
  - Modify: `packages/happy-app/sources/app/_layout.tsx`

  **Approach:**
  - Wrap `Notifications.setNotificationHandler()` call in `if (!isTauri())` guard
  - Wrap `Notifications.setNotificationChannelAsync()` (Android) in same guard
  - Wrap notification response listener registration in `RootLayout` component in `isTauri()` guard
  - Import `isTauri` from `@/utils/platform`
  - The module-level `import * as Notifications from 'expo-notifications'` stays — it's tree-shaken on web and won't crash on import, only on API calls

  **Patterns to follow:**
  - Existing `Platform.OS === 'android'` guard for notification channels in same file

  **Test scenarios:**
  - Happy path: App launches in Tauri without notification-related console errors
  - Happy path: App on iOS/Android still initializes notifications normally (regression check)
  - Edge case: Notification response listener is not registered in Tauri — deep link from notification does not apply

  **Verification:**
  - `pnpm tauri:dev` — app launches cleanly, no expo-notifications errors in console
  - `pnpm typecheck` passes

---

### Phase 2: Three-Column Layout

- [ ] **Unit 4: Desktop Layout Container**

  **Goal:** Replace expo-router Drawer with custom three-column flex layout on desktop

  **Requirements:** R13, R16

  **Dependencies:** Unit 1 (isDesktop)

  **Files:**
  - Modify: `packages/happy-app/sources/components/SidebarNavigator.tsx`
  - Create: `packages/happy-app/sources/components/DesktopLayout.tsx`
  - Create: `packages/happy-app/sources/components/ContextPanel.tsx` (shell/placeholder)
  - Modify: `packages/happy-app/sources/components/layout.ts` (remove maxWidth constraints for desktop)

  **Approach:**
  - In `SidebarNavigator.tsx`: when `isDesktop()`, render `<DesktopLayout>` instead of `<Drawer>`
  - `DesktopLayout`: `flexDirection:'row'` container with three children:
    1. `<SidebarView />` (existing, unchanged, width ~300px)
    2. `<Slot />` from expo-router (Center, flex:1) — renders current route
    3. `<ContextPanel />` (new, width ~300px, placeholder content for P0)
  - `ContextPanel` P0 implementation: static placeholder text "Context panel — coming soon" with matching background color. No dynamic data (git status deferred to P1/R15)
  - Update `layout.ts`: when `isDesktop()`, set `maxWidth` and `maxLayoutWidth` to unconstrained (content fills center column naturally)
  - Preserve existing Drawer behavior for mobile/tablet (`!isDesktop()` path unchanged)
  - Add Zen mode: boolean state in React context (`useZenMode` hook in `hooks/useZenMode.ts`), backed by `localStorage` for persistence across restarts. Toggle via `useGlobalKeyboard` registering `Cmd+0` / `Ctrl+0`. When active, hide SidebarView and ContextPanel, Center takes full width

  **Patterns to follow:**
  - `layout-core.md` for column widths, Zen mode behavior, and design decisions
  - Existing `SidebarNavigator` conditional rendering pattern

  **Test scenarios:**
  - Happy path: Desktop (Tauri) shows three-column layout with SidebarView, center content, and ContextPanel
  - Happy path: Mobile/tablet shows existing Drawer layout (no regression)
  - Happy path: Navigating between routes (session, settings, friends) updates center column while sidebar/context persist
  - Happy path: Zen mode (Cmd+0) hides both side panels, center fills window
  - Edge case: Window resized to minimum width (900px) — three columns still render without overflow
  - Edge case: Auth state false — sidebar/context hidden, only center renders (login screen)

  **Verification:**
  - Three-column layout visible in `pnpm tauri:dev`
  - Navigation between routes works with sidebar persisting
  - Zen mode toggles correctly
  - Mobile web (`pnpm web`) still uses Drawer layout

---

### Phase 3: Native Desktop Capabilities

- [ ] **Unit 5: System Tray**

  **Goal:** Add system tray icon with status and session list, close-to-tray behavior

  **Requirements:** R3, R4

  **Dependencies:** Unit 2 (plugin scaffolding)

  **Files:**
  - Modify: `packages/happy-app/src-tauri/src/lib.rs`
  - Create: `packages/happy-app/src-tauri/src/tray.rs`
  - Create: `packages/happy-app/sources/sync/tauriTray.ts` (JS-side tray state bridge)
  - Test: `packages/happy-app/sources/sync/tauriTray.test.ts`
  - Modify: `packages/happy-app/sources/sync/sync.ts` (emit tray updates on connection/session changes)

  **Approach:**
  - Rust `tray.rs`: Create `TrayIconBuilder` with app icon, build context menu (Show Window, separator, session list placeholder, New Session, separator, Quit)
  - `#[tauri::command] fn update_tray_status(online: bool, sessions: Vec<TraySession>)` — rebuilds menu with current sessions
  - Intercept window close event via `on_window_event` — on `CloseRequested`, hide window instead of closing. Set `event.prevent_close()`, call `window.hide()`
  - Double-click tray icon: show and focus window
  - Tray menu actions emit events: `tray-action` with action type and optional session ID
  - JS-side `tauriTray.ts`: listens for `tray-action` events, routes to navigation. Calls `invoke('update_tray_status')` when sync connection state or session list changes
  - Add tray icon files for each platform (PNG for Linux, ICO for Windows, template image for macOS)

  **Patterns to follow:**
  - Tauri v2 tray API (`tauri::tray::TrayIconBuilder`)
  - Existing `apiSocket` connection state in `sync.ts` for status updates

  **Test scenarios:**

  *自动化单测 (`tauriTray.test.ts`, mock `invoke()` + `listen()`)：*
  - Happy path: `formatTrayStatus()` 将 session 列表截断为最多 5 个，按 `activeAt` 降序排列
  - Happy path: 在线/离线状态正确映射到 `invoke('update_tray_status')` 参数
  - Edge case: 空 session 列表 → invoke 参数包含 `sessions: []`
  - Happy path: `tray-action` 事件 `{ action: "navigate", sessionId: "abc" }` 路由到 `/session/abc`
  - Happy path: `tray-action` 事件 `{ action: "new-session" }` 路由到 `/new`

  *手动验证（Tauri 运行时）：*
  - Happy path: Tray icon appears on app launch with correct status icon
  - Happy path: Right-click shows context menu with active sessions listed
  - Happy path: Clicking "Show Window" shows and focuses the app window
  - Happy path: Clicking a session in tray menu opens window and navigates to that session
  - Happy path: Closing window hides to tray, tray icon persists
  - Happy path: Double-clicking tray icon restores window
  - Error path: No active sessions — menu shows "No active sessions" disabled item
  - Integration: Connection status changes (online/offline) update tray icon appearance
  - Happy path (macOS): Close button (traffic lights) hides to tray, not quits
  - Happy path (Windows): Close button hides to tray, not quits
  - Happy path (Linux): Close button hides to tray, not quits (test on GNOME and KDE)
  - Error path: If `on_window_event(CloseRequested)` doesn't fire on a platform, close quits app (acceptable degradation, document as known limitation)

  **Verification:**
  - Tray icon visible in system tray on macOS, Windows, Linux
  - Close-to-tray works on all three platforms (or documented as known limitation on specific platform)
  - Tray menu reflects current session state

---

- [ ] **Unit 6: Native Notifications**

  **Goal:** Send OS-native notifications from Tauri and handle click-to-navigate

  **Requirements:** R7, R8

  **Dependencies:** Unit 2 (notification plugin), Unit 1 (isTauri), Unit 3 (expo-notifications bypass)

  **Files:**
  - Modify: `packages/happy-app/src-tauri/src/lib.rs` (notification command)
  - Create: `packages/happy-app/sources/sync/tauriNotifications.ts`
  - Test: `packages/happy-app/sources/sync/tauriNotifications.test.ts`
  - Modify: `packages/happy-app/sources/sync/sync.ts` (hook notification triggers)
  - Modify: `packages/happy-app/sources/app/_layout.tsx` (register Tauri notification listener for click-to-navigate)

  **Approach:**
  - Rust `send_notification` command: uses `tauri_plugin_notification` to show OS notification with title, body, and custom data (route to navigate on click)
  - JS `tauriNotifications.ts`: exports `sendDesktopNotification(title, body, route)` that calls `invoke('send_notification')`. Includes logic for: suppress when window is focused (check `document.hasFocus()`), 5s dedup per session
  - **Notification content policy (security requirement):** Notification body must NOT contain chat message content, API keys, or other sensitive data. Use only session name and action type (e.g., "Permission request received", "Session completed"). Notifications are visible on lock screen and in OS notification logs
  - Hook into sync update handlers at specific points in `sync.ts`:
    - `agentState` 变更（权限请求）: 在 `handleUpdate()` 中处理 `update-session` 类型且 `agentState` 非 null 时触发
    - 会话完成/错误: 在 session 状态从 `active=true` 变为 `active=false` 时触发
    - 好友请求: 在 `handleUpdate()` 中处理 `relationship-updated` 类型时触发
    - Hook 模式: 在 `sync.ts` 的 update handler 末尾调用 `tauriNotifications.onSyncUpdate(updateType, data)`，所有 dedup/suppress 逻辑封装在 `tauriNotifications.ts` 中，不在 sync.ts 中添加复杂逻辑
  - In `_layout.tsx`: when `isTauri()`, register Tauri event listener for `notification-clicked` events and route to the specified path using `router.push()`

  **Patterns to follow:**
  - Existing notification response routing in `_layout.tsx` (`getSessionRouteFromNotificationResponse`, `navigateToSession`)
  - Existing `useHappyAction` for error handling pattern

  **Test scenarios:**

  *自动化单测 (`tauriNotifications.test.ts`, mock `invoke()` + `document.hasFocus`)：*
  - Happy path: `sendDesktopNotification()` 调用 `invoke('send_notification')` 并传递正确参数
  - Happy path: `document.hasFocus() === true` 时不调用 `invoke`（窗口前台 suppress）
  - Edge case: 同一 sessionId 5s 内第二次调用 → 不触发 `invoke`（dedup）
  - Edge case: 5s 后同一 sessionId 再次调用 → 正常触发 `invoke`（dedup 过期）
  - Security: 验证传给 `invoke` 的 body 不包含 `content` 字段内容（内容策略）
  - Happy path: `onSyncUpdate('update-session', { agentState: {...} })` 触发通知
  - Happy path: `onSyncUpdate('relationship-updated', {...})` 触发好友请求通知
  - Edge case: `onSyncUpdate('update-session', { agentState: null })` 不触发通知

  *手动验证（Tauri 运行时）：*
  - Happy path: Permission request triggers native notification on macOS/Windows/Linux
  - Happy path: Clicking notification opens window and navigates to correct session
  - Edge case: Click notification for a deleted session — fallback to home screen
  - Integration: Sync update for agentState change → notification → click → navigation to session

  **Verification:**
  - Native notifications appear on all three platforms
  - Click-to-navigate works correctly
  - No notifications when window is focused

---

- [ ] **Unit 7: OS Keychain Secure Storage**

  **Goal:** Store credentials in OS keychain, migrate from localStorage

  **Requirements:** R9

  **Dependencies:** Unit 1 (isTauri), Unit 2 (Rust scaffolding)

  **Files:**
  - Modify: `packages/happy-app/src-tauri/src/lib.rs` (register keychain commands)
  - Create: `packages/happy-app/src-tauri/src/keychain.rs`
  - Modify: `packages/happy-app/sources/auth/tokenStorage.ts`
  - Test: `packages/happy-app/sources/auth/tokenStorage.test.ts`

  **Approach:**
  - Rust `keychain.rs`: Three commands using the `keyring` crate:
    - `keychain_get(service, key)` → `Option<String>`
    - `keychain_set(service, key, value)` → `Result<(), String>`
    - `keychain_delete(service, key)` → `Result<(), String>`
    - Service name: `"com.slopus.happy"`, key: `"auth_credentials"`
    - Linux build prerequisite: `libsecret-1-dev` (Ubuntu/Debian) or `libsecret-devel` (Fedora). Required by `keyring` crate for Secret Service integration
  - Modify `tokenStorage.ts`:
    - When `isTauri()`: use `invoke('keychain_get/set/delete')` instead of `localStorage`
    - On first call to `getCredentials()` in Tauri: check if keychain has credentials. If not, check `localStorage` for existing credentials (migration). If found: (1) write to keychain, (2) set `localStorage['_keychain_migrated'] = 'true'` as migration flag, (3) delete localStorage credentials entry. On subsequent calls, check migration flag to skip re-migration
    - Migration is one-time, transparent to the user. If keychain write fails, abort migration (don't touch localStorage). If app crashes between write and delete, migration flag prevents duplicate writes on next launch
  - Keep existing `localStorage` path unchanged for plain web
  - Keep existing `expo-secure-store` path unchanged for native

  **Patterns to follow:**
  - Existing platform branching in `tokenStorage.ts` (`Platform.OS === 'web'` vs native)
  - `invoke()` pattern from `@tauri-apps/api/core`

  **Test scenarios:**

  *自动化单测 (`tokenStorage.test.ts`, mock `invoke()` + mock `localStorage` + mock `isTauri`)：*
  - Happy path: `isTauri()=true`, keychain 有凭据 → `getCredentials()` 调用 `invoke('keychain_get')` 并返回凭据
  - Happy path: `isTauri()=true`, 新安装（keychain 空, localStorage 空）→ `setCredentials()` 调用 `invoke('keychain_set')`
  - Happy path: 迁移场景 — keychain 空 + localStorage 有凭据 + 无 migration flag → (1) `invoke('keychain_set')` 写入, (2) 设 `_keychain_migrated` flag, (3) 删除 localStorage 凭据
  - Edge case: 迁移幂等 — `_keychain_migrated` flag 存在 → 不读取 localStorage
  - Error path: `invoke('keychain_set')` 抛异常 → 不删除 localStorage，返回 warning
  - Edge case: 崩溃恢复 — keychain 有数据但 localStorage 也有（flag 丢失）→ keychain 优先，不重复写入
  - Happy path: `isTauri()=false` → 走原有 localStorage/SecureStore 路径（回归测试）
  - Happy path: `logout()` 在 Tauri 中调用 `invoke('keychain_delete')`

  *手动验证（Tauri 运行时）：*
  - Happy path: Credentials not in localStorage after Tauri app login
  - Happy path: macOS Keychain Access app shows `com.slopus.happy` entry
  - Integration: Full auth flow — login via QR → credentials in keychain → app restart → credentials restored from keychain
  - Error path: Linux without Secret Service → Modal.alert() 警告用户

  **Verification:**
  - Credentials not in localStorage after Tauri app login
  - macOS: Keychain Access app shows `com.slopus.happy` entry
  - App restart preserves authentication

---

- [ ] **Unit 8: Window State Persistence**

  **Goal:** Remember and restore window size/position across restarts

  **Requirements:** R5

  **Dependencies:** Unit 2 (plugin scaffolding)

  **Files:**
  - Modify: `packages/happy-app/src-tauri/src/lib.rs` (add window-state plugin if using tauri-plugin-window-state, or manual save/restore)

  **Approach:**
  - Use `tauri-plugin-window-state` (installed in Unit 2) — it handles save/restore automatically with zero JS code. Plugin persists window size, position, and maximized state to the app's config directory
  - State is persisted synchronously on window hide (close-to-tray from Unit 5) and on app quit
  - Register the plugin in `lib.rs` builder chain: `.plugin(tauri_plugin_window_state::Builder::default().build())`

  **Patterns to follow:**
  - Tauri v2 window state management documentation

  **Test scenarios:**
  - Happy path: Resize window to custom size → close → reopen → same size and position
  - Happy path: Move window to secondary monitor → close → reopen → correct monitor
  - Edge case: Saved position is off-screen (monitor disconnected) — window appears on primary monitor

  **Verification:**
  - Window size/position survives app restart
  - Window size/position survives close-to-tray + restore

---

### Phase 4: Verification & Build

- [ ] **Unit 9: Feature Verification Pass**

  **Goal:** Systematically verify all core workflows in Tauri webview

  **Requirements:** V1, V2

  **Dependencies:** Units 1-8

  **Files:**
  - No new files — this is a verification pass

  **Approach:**
  - Test each core workflow in `pnpm tauri:dev`:
    - Account creation via QR (V2): desktop displays QR, mobile scans, auth completes
    - Account restoration via manual key input (V2)
    - Session creation: select machine, configure, spawn
    - Session viewing: messages render, tool outputs display, real-time updates work
    - File browser: git status, file list, diff viewing
    - Friend management: search, add, accept/reject
    - Artifacts: create, view, edit, delete
    - Settings: all settings screens accessible and functional
    - Theme switching: dark/light mode
    - Command palette: Cmd+K opens palette
  - Document any failures as issues to fix before shipping

  **Test expectation:** Manual verification checklist — no automated tests for this unit

  **Verification:**
  - All listed workflows complete successfully in Tauri on macOS
  - QR auth flow works (mobile scans desktop QR)
  - No console errors during normal operation

---

- [ ] **Unit 10: Cross-Platform Build Configuration**

  **Goal:** Ensure builds succeed on macOS, Windows, and Linux

  **Requirements:** R21, R23

  **Dependencies:** Units 1-8

  **Files:**
  - Modify: `packages/happy-app/src-tauri/tauri.conf.json` (bundle targets)
  - Optionally create: `.github/workflows/tauri-build.yml` (CI matrix)

  **Approach:**
  - Verify `tauri.conf.json` bundle config: `"targets": "all"` should produce .dmg/.app (macOS), .msi/.exe (Windows), .AppImage/.deb (Linux)
  - Test local build on macOS: `pnpm tauri:build:dev`
  - Document build prerequisites for each platform (Rust toolchain, platform-specific libs)
  - CI/CD: if desired, create GitHub Actions workflow with matrix strategy (macos-latest, windows-latest, ubuntu-latest). Each runs `pnpm install && pnpm tauri:build:production`. This is optional for P0 — manual builds are acceptable initially

  **Test expectation:** Build succeeds on at least macOS. Windows/Linux builds verified via CI or manual testing on target platforms

  **Verification:**
  - `pnpm tauri:build:dev` produces a working .app/.dmg on macOS
  - Build artifacts exist for all configured platforms (or CI green)

## System-Wide Impact

- **Interaction graph:** `sync.ts` → `tauriNotifications.ts` (notification triggers), `sync.ts` → `tauriTray.ts` (tray status updates), `_layout.tsx` → Tauri event listeners (notification click, tray actions)
- **Error propagation:** Tauri `invoke()` failures should be caught and logged, not surfaced to user. Keychain failures fall back to localStorage with UI-level `Modal.alert()` warning (not just console). Notification failures are silent (non-critical)
- **State lifecycle risks:** Window state must be saved before hide-to-tray (synchronous). Keychain migration must be atomic (write new → delete old, not delete old → write new)
- **API surface parity:** No server-side changes. `sentFrom` field in sync will still send `"web"` for Tauri — changing to `"desktop"` is a future improvement
- **Integration coverage:** Full auth flow (QR → keychain → restart → restore) is the highest-risk integration path. Sync → notification → click → navigation is the second
- **Unchanged invariants:** Mobile app (iOS/Android) is completely unaffected. Web app (`pnpm web`) is unaffected (all Tauri paths gated by `isTauri()`). Server requires zero changes

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| `expo-router/drawer` replacement breaks navigation state | `<Slot/>` is the standard expo-router pattern for custom layouts. SidebarNavigator already conditionally renders — desktop path is additive, not replacing mobile path |
| `keyring` crate fails on some Linux distros without Secret Service | Fall back to localStorage with console warning. Document Secret Service as a requirement for secure storage on Linux |
| CSP breaks legitimate app functionality | Start with permissive CSP, tighten iteratively. Test all resource loading (fonts, images, API calls, WebSocket) after CSP change |
| Tauri plugin version incompatibility | Pin all plugin versions to match Tauri 2.8.2 compatibility. Check Tauri v2 compatibility matrix |
| Three-column layout causes mobile regression | Desktop path (`isDesktop()`) is strictly separated from existing Drawer path. No shared code modified except the branching point in SidebarNavigator |

## Documentation / Operational Notes

- Update `packages/happy-app/CLAUDE.md` to document new Tauri commands (`pnpm tauri:dev` prerequisites, new Rust commands)
- Update `docs/CONTRIBUTING.md` development setup section if Rust toolchain instructions change
- Consider updating `README.md` to mention desktop app availability

## Sources & References

- **Origin document:** [docs/brainstorms/2026-04-14-tauri-desktop-native-requirements.md](docs/brainstorms/2026-04-14-tauri-desktop-native-requirements.md)
- **Layout spec:** [docs/layout-core.md](docs/layout-core.md)
- Related code: `packages/happy-app/src-tauri/` (all Tauri config and Rust code)
- Related code: `packages/happy-app/sources/utils/platform.ts` (platform detection)
- Related code: `packages/happy-app/sources/components/SidebarNavigator.tsx` (layout entry point)
- Related code: `packages/happy-app/sources/auth/tokenStorage.ts` (credential storage)
- Related code: `packages/happy-app/sources/app/_layout.tsx` (notification init, font loading)
- External: Tauri v2 documentation (tray, notification, capabilities, CSP)
- External: `keyring` Rust crate for cross-platform OS keychain
