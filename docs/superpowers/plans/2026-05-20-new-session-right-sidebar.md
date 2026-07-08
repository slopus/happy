# New Session Right Sidebar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move `/new` session configuration into the right sidebar on supported desktop layouts while keeping fallback layouts unchanged.

**Architecture:** Extract a testable sidebar layout helper in `sources/utils/newSessionSidebarLayout.ts` and a local config component in `packages/happy-app/sources/app/(app)/new/index.tsx`. Use the active-session sidebar width and support rules, then render the config either inline or in a right sidebar.

**Tech Stack:** Expo Router, React Native, React Native Web, Unistyles, Vitest, TypeScript.

---

## File Structure

- Create `packages/happy-app/sources/utils/newSessionSidebarLayout.ts`: pure helper for right-sidebar gating and width.
- Modify `packages/happy-app/sources/app/(app)/new/index.tsx`: import layout helper, extract config rendering into a local component, render right sidebar on supported layouts, and center the composer.
- Create `packages/happy-app/sources/utils/newSessionSidebarLayout.test.ts`: focused unit tests for layout gating and width.

### Task 1: Add Sidebar Layout Helper Test

**Files:**
- Create: `packages/happy-app/sources/utils/newSessionSidebarLayout.test.ts`
- Create: `packages/happy-app/sources/utils/newSessionSidebarLayout.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/happy-app/sources/utils/newSessionSidebarLayout.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { getNewSessionSidebarLayout } from './newSessionSidebarLayout';

describe('getNewSessionSidebarLayout', () => {
  it('enables the right sidebar on supported wide web layouts', () => {
    expect(getNewSessionSidebarLayout({
      platform: 'web',
      isMac: false,
      fileDiffsSidebarEnabled: true,
      zenMode: false,
      windowWidth: 1200,
    })).toEqual({
      canShowSidebar: true,
      showSidebar: true,
      sidebarWidth: 360,
    });
  });

  it('disables the sidebar when the setting is off', () => {
    expect(getNewSessionSidebarLayout({
      platform: 'web',
      isMac: false,
      fileDiffsSidebarEnabled: false,
      zenMode: false,
      windowWidth: 1200,
    }).showSidebar).toBe(false);
  });

  it('disables the sidebar in zen mode', () => {
    expect(getNewSessionSidebarLayout({
      platform: 'web',
      isMac: false,
      fileDiffsSidebarEnabled: true,
      zenMode: true,
      windowWidth: 1200,
    }).showSidebar).toBe(false);
  });

  it('disables the sidebar below the minimum width', () => {
    expect(getNewSessionSidebarLayout({
      platform: 'web',
      isMac: false,
      fileDiffsSidebarEnabled: true,
      zenMode: false,
      windowWidth: 1099,
    }).showSidebar).toBe(false);
  });

  it('disables the sidebar on unsupported native platforms', () => {
    expect(getNewSessionSidebarLayout({
      platform: 'ios',
      isMac: false,
      fileDiffsSidebarEnabled: true,
      zenMode: false,
      windowWidth: 1400,
    }).showSidebar).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
pnpm --dir packages/happy-app test sources/utils/newSessionSidebarLayout.test.ts
```

Expected: FAIL because `newSessionSidebarLayout.ts` does not exist.

- [ ] **Step 3: Add the helper**

Create `packages/happy-app/sources/utils/newSessionSidebarLayout.ts`:

```ts
const RIGHT_SIDEBAR_MIN_WINDOW_WIDTH = 1100;

type NewSessionSidebarLayoutInput = {
    platform: 'web' | 'ios' | 'android' | 'macos' | 'windows';
    isMac: boolean;
    fileDiffsSidebarEnabled: boolean;
    zenMode: boolean;
    windowWidth: number;
};

export function getNewSessionSidebarLayout(input: NewSessionSidebarLayoutInput) {
    const canShowSidebar = input.fileDiffsSidebarEnabled
        && (input.isMac || input.platform === 'web')
        && input.windowWidth >= RIGHT_SIDEBAR_MIN_WINDOW_WIDTH;
    const showSidebar = canShowSidebar && !input.zenMode;
    const sidebarWidth = Math.min(Math.max(Math.floor(input.windowWidth * 0.3), 250), 360);
    return { canShowSidebar, showSidebar, sidebarWidth };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
pnpm --dir packages/happy-app test sources/utils/newSessionSidebarLayout.test.ts
```

Expected: PASS.

### Task 2: Move Config UI Into Reusable Component

**Files:**
- Modify: `packages/happy-app/sources/app/(app)/new/index.tsx`

- [ ] **Step 1: Extract a `NewSessionConfigPanel` component**

Move the current config-box JSX and related flash/popover rendering into a local component. Pass existing values and callbacks from `NewSessionScreen`. Keep `activePicker` owned by `NewSessionScreen` so native sheets still work.

- [ ] **Step 2: Preserve inline behavior**

Replace the original inline JSX with:

```tsx
<View style={styles.inlineConfigWrap}>
    <NewSessionConfigPanel ...existingProps />
</View>
```

Expected: no visual behavior change before sidebar rendering is added.

- [ ] **Step 3: Run typecheck**

Run:

```bash
pnpm --dir packages/happy-app typecheck
```

Expected: PASS.

### Task 3: Add Desktop Right Sidebar Layout

**Files:**
- Modify: `packages/happy-app/sources/app/(app)/new/index.tsx`

- [ ] **Step 1: Read layout settings**

In `NewSessionScreen`, read:

```ts
const { width: windowWidth } = useWindowDimensions();
const fileDiffsSidebarEnabled = useSetting('fileDiffsSidebar');
const zenMode = useLocalSetting('zenMode');
```

- [ ] **Step 2: Compute sidebar layout**

Call:

```ts
const sidebarLayout = getNewSessionSidebarLayout({
    platform: Platform.OS,
    isMac: isRunningOnMac(),
    fileDiffsSidebarEnabled,
    zenMode,
    windowWidth,
});
```

- [ ] **Step 3: Render centered composer and right sidebar**

When `sidebarLayout.showSidebar` is true, render a row:

```tsx
<View style={styles.desktopShell}>
    <View style={styles.desktopMain}>
        <View style={styles.centeredComposerWrap}>
            {composerNode}
        </View>
    </View>
    <View style={[styles.rightSidebar, { width: sidebarLayout.sidebarWidth }]}>
        <NewSessionConfigPanel ...existingProps />
    </View>
</View>
```

When false, keep the existing inline config and bottom composer behavior.

- [ ] **Step 4: Run tests and typecheck**

Run:

```bash
pnpm --dir packages/happy-app test sources/utils/newSessionSidebarLayout.test.ts
pnpm --dir packages/happy-app typecheck
```

Expected: PASS.

### Task 4: Browser Verification

**Files:**
- Modify only if verification reveals a bug in `packages/happy-app/sources/app/(app)/new/index.tsx`.

- [ ] **Step 1: Start web app**

Run:

```bash
pnpm --dir packages/happy-app web:test
```

Expected: Expo web server starts and prints a local URL.

- [ ] **Step 2: Verify `/new` at desktop width**

Open `/new` at a width >= 1100 px. Expected: left sidebar remains, right sidebar shows new-session settings, prompt composer is centered in the main area.

- [ ] **Step 3: Verify narrow fallback**

Open `/new` below 1100 px. Expected: no right sidebar; current inline settings above composer remain.

- [ ] **Step 4: Stop web app**

Stop the web server cleanly.

### Task 5: Final Hygiene

**Files:**
- All changed files.

- [ ] **Step 1: Run diff hygiene**

Run:

```bash
git diff --check
```

Expected: no whitespace errors.

- [ ] **Step 2: Review changed files**

Run:

```bash
git diff --stat
git diff -- packages/happy-app/sources/app/\\(app\\)/new/index.tsx packages/happy-app/sources/utils/newSessionSidebarLayout.ts packages/happy-app/sources/utils/newSessionSidebarLayout.test.ts
```

Expected: changes are limited to the approved `/new` right-sidebar work and docs.
