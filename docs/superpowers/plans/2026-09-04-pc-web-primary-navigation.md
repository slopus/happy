# PC Web Primary Navigation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a desktop primary-navigation column and an inline Session History list without changing the mobile drawer or existing routed conversation pane.

**Architecture:** `SidebarView` composes desktop primary and secondary columns while keeping the mobile hierarchy intact. `DesktopSidebarSessionsNavigation` persists a new `history` mode and renders a shared `SessionHistoryList`; `SidebarNavigator` reserves a fixed primary width outside the resizable list-width contract.

**Tech Stack:** React 19, React Native Web, Expo Router, Unistyles, Vitest, react-test-renderer

**Spec:** `docs/superpowers/specs/2026-09-04-pc-web-primary-navigation-design.md`

## Global Constraints

- Modify only `/Users/jacky/jacky-github/happy--pc-web-primary-navigation` on `feat/pc-web-primary-navigation`; keep the root checkout clean on `main`.
- Keep Projects / Lists / Timeline in the secondary list column and preserve the mobile single-column drawer.
- Use `theme.colors.surface`, `theme.colors.surfacePressed`, and `theme.colors.surfaceSelected` for interactive surface states.
- Validate the visible desktop behavior in the default theme and `ginghamDark` using Ego browser only.
- Capture Case-based visual evidence and obtain an independent review before completion.

---

### Task 1: Persist and render Session History as a secondary-column mode

**Files:**
- Create: `packages/happy-app/sources/components/SessionHistoryList.tsx`
- Create: `packages/happy-app/sources/components/SessionHistoryList.test.tsx`
- Modify: `packages/happy-app/sources/app/(app)/session/recent.tsx`
- Modify: `packages/happy-app/sources/components/DesktopSidebarSessionsNavigation.tsx`
- Modify: `packages/happy-app/sources/components/DesktopSidebarSessionsNavigation.test.tsx`
- Modify: `packages/happy-app/sources/sync/localSettings.ts`
- Modify: `packages/happy-app/sources/sync/localSettings.test.ts`

**Interfaces:**
- Produces: `SessionHistoryList({ variant?: 'page' | 'sidebar' })` and persisted `desktopSidebarMode: 'projects' | 'lists' | 'timeline' | 'history'`.
- Consumes: `useAllSessions`, `useNavigateToSession`, existing session-name/subtitle/avatar helpers, and semantic theme tokens.

- [ ] **Step 1: Write failing tests** asserting that `history` survives local-setting parsing, history mode renders `SessionHistoryList` without adding a fourth tab, date groups sort newest-first, and a history row calls `navigateToSession(session.id)`.
- [ ] **Step 2: Verify RED** with `pnpm --filter happy-app test --run sources/sync/localSettings.test.ts sources/components/DesktopSidebarSessionsNavigation.test.tsx sources/components/SessionHistoryList.test.tsx`; expect failures because the schema rejects `history` and the shared component does not exist.
- [ ] **Step 3: Implement minimally** by extracting the current recent-page list into `SessionHistoryList`, adding a compact sidebar variant, adding the schema enum member, and rendering it for mode `history`.
- [ ] **Step 4: Verify GREEN** with the same Vitest command; expect all selected files to pass.

### Task 2: Split the desktop drawer into primary and secondary columns

**Files:**
- Modify: `packages/happy-app/sources/components/SidebarView.tsx`
- Modify: `packages/happy-app/sources/components/SidebarView.test.tsx`
- Modify: `packages/happy-app/sources/components/SidebarNavigator.tsx`
- Modify: `packages/happy-app/sources/components/SidebarNavigator.test.tsx`
- Modify: `packages/happy-app/sources/utils/desktopNavigationLayout.ts`

**Interfaces:**
- Produces: exported `DESKTOP_PRIMARY_NAVIGATION_WIDTH`, desktop test IDs `desktop-primary-navigation-column` and `desktop-secondary-navigation-column`, and primary-history action `sidebar-history-button`.
- Consumes: the existing `go`, command-palette, plugin marketplace, Agent sheet, account/help footer, `desktopSidebarMode` setter, and resizable secondary width.

- [ ] **Step 1: Write failing tests** asserting that desktop renders two sibling columns, the primary column contains exactly the six requested actions, history sets `desktopSidebarMode` to `history`, the secondary column owns `DesktopSidebarSessionsNavigation`, mobile stays single-column, and drawer/header/resize offsets add the fixed primary width only on desktop.
- [ ] **Step 2: Verify RED** with `pnpm --filter happy-app test --run sources/components/SidebarView.test.tsx sources/components/SidebarNavigator.test.tsx`; expect missing columns/history action and unchanged drawer width.
- [ ] **Step 3: Implement minimally** by composing desktop column wrappers in `SidebarView`, moving the existing global controls into the primary wrapper, adding the history action, and adding `DESKTOP_PRIMARY_NAVIGATION_WIDTH` at `SidebarNavigator`'s layout boundary.
- [ ] **Step 4: Verify GREEN** with the same Vitest command; expect both test files to pass.

### Task 3: Regression and theme verification

**Files:**
- Modify only files required by test/type errors from Tasks 1–2.

**Interfaces:**
- Consumes: all changed components and storage types.
- Produces: type-safe desktop/mobile behavior with existing Projects / Lists / Timeline tests intact.

- [ ] **Step 1: Run the focused suite** with `pnpm --filter happy-app test --run sources/sync/localSettings.test.ts sources/components/SessionHistoryList.test.tsx sources/components/DesktopSidebarSessionsNavigation.test.tsx sources/components/SidebarView.test.tsx sources/components/SidebarNavigator.test.tsx`.
- [ ] **Step 2: Run type checking** with `pnpm --filter happy-app typecheck`.
- [ ] **Step 3: Inspect the diff** with `git diff --check` and `git diff --stat`, then verify interactive styles use semantic tokens and no desktop behavior leaked into the mobile branch.

### Task 4: Real desktop acceptance and independent review

**Files:**
- Create: Case-based PNG evidence under the repository's established visual-evidence location discovered during execution.
- Modify only source/test files needed to fix verified acceptance failures.

**Interfaces:**
- Consumes: a locally running Happy Web build, Ego browser, authenticated test state, and the `ginghamDark` theme.
- Produces: verified screenshots for Cases 1–6 and independent code/interaction review findings.

- [ ] **Step 1: Read and follow** `ego-browser`, `web-e2e`, and `pc-web-interaction-reviewer` before browser actions.
- [ ] **Step 2: Start the existing local Web workflow** and open it with Ego at a desktop viewport.
- [ ] **Step 3: Verify Cases 1–5** by exercising every primary action, Projects / Lists / Timeline switching, history-list selection into the right pane, and a mobile-width regression pass; capture and report each meaningful verified browser round.
- [ ] **Step 4: Verify Case 6** in `ginghamDark`, including normal, hover/pressed, and selected states; capture and report the final verified browser state.
- [ ] **Step 5: Run an independent review** against the implementation, test evidence, and screenshots; resolve blocking findings and rerun affected checks.
