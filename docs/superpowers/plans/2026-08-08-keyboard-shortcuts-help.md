# Keyboard Shortcuts Help Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Paws PC Web a discoverable help menu and a platform-aware keyboard-shortcuts reference that opens from the sidebar or with `Command/Ctrl + /`, while preserving the already implemented `Command/Ctrl + ,` settings shortcut.

**Architecture:** Add a Web-only `KeyboardShortcutsProvider` beneath the existing modal provider. It exposes a launcher context, registers the global slash shortcut through `useGlobalKeyboard`, and opens one custom modal at a time. A pure typed catalog produces localized sections from runtime capabilities; a presentational modal renders those sections; a sidebar help popover owns its own menu/focus behavior and delegates modal opening to the provider.

**Tech Stack:** React Native Web, Expo Router, TypeScript, react-native-unistyles, Vitest, react-test-renderer, existing Paws modal/i18n/storage utilities.

## Global Constraints

- Work only in `/Users/jacky/jacky-github/happy--fix-web-settings-shortcut`; keep `/Users/jacky/jacky-github/happy` clean and aligned to `origin/main`.
- Follow TDD for each behavior slice: add or update a focused test, observe the intended failure, implement the smallest change, rerun the focused suite.
- Use `t(...)` for every visible string and update `_default.ts` plus all ten translation files. The package instructions require the i18n-translator agent for translation additions/verification.
- Keep the feature PC Web-only. Do not start Expo Web, Tauri, a simulator, an emulator, or OTA publishing without separate approval for the exact command.
- Do not advertise shortcuts that do not have a real handler. In particular, exclude the display-only `Command + N` and unsupported `Command + Enter` behaviors.
- Preserve unrelated dirty-worktree changes. The four existing `Command/Ctrl + ,` changes belong to this branch and are finalized in Task 1.

---

## Task 1: Finalize the Existing App-Settings Shortcut Slice

**Files:**

- Modify: `packages/happy-app/sources/hooks/useGlobalKeyboard.ts`
- Modify: `packages/happy-app/sources/hooks/useGlobalKeyboard.test.tsx`
- Modify: `packages/happy-app/sources/components/CommandPalette/CommandPaletteProvider.tsx`
- Modify: `packages/happy-app/sources/components/CommandPalette/CommandPaletteProvider.test.tsx`

- [ ] **Step 1: Inspect the existing four-file diff**

Run:

```bash
git diff -- packages/happy-app/sources/hooks/useGlobalKeyboard.ts \
    packages/happy-app/sources/hooks/useGlobalKeyboard.test.tsx \
    packages/happy-app/sources/components/CommandPalette/CommandPaletteProvider.tsx \
    packages/happy-app/sources/components/CommandPalette/CommandPaletteProvider.test.tsx
```

Expected: only the optional `onOpenSettings`, the `Command/Ctrl + ,` branch, the `/settings` launcher, and the two focused regressions are present.

- [ ] **Step 2: Re-run the focused green tests**

Run from `packages/happy-app`:

```bash
pnpm exec vitest run \
    sources/hooks/useGlobalKeyboard.test.tsx \
    sources/components/CommandPalette/CommandPaletteProvider.test.tsx
```

Expected: both suites pass.

- [ ] **Step 3: Commit the settings shortcut independently**

```bash
git add packages/happy-app/sources/hooks/useGlobalKeyboard.ts \
    packages/happy-app/sources/hooks/useGlobalKeyboard.test.tsx \
    packages/happy-app/sources/components/CommandPalette/CommandPaletteProvider.tsx \
    packages/happy-app/sources/components/CommandPalette/CommandPaletteProvider.test.tsx
git commit -m "fix(app): open settings from web shortcut" \
    -m "Co-Authored-By: Codex <codex@openai.com>"
```

---

## Task 2: Extend the Global Keyboard Hook for `Command/Ctrl + /`

**Files:**

- Modify: `packages/happy-app/sources/hooks/useGlobalKeyboard.test.tsx`
- Modify: `packages/happy-app/sources/hooks/useGlobalKeyboard.ts`

- [ ] **Step 1: Add failing slash-shortcut tests**

Extend the harness options with `onOpenKeyboardShortcuts` and add cases equivalent to:

```tsx
it('opens keyboard shortcuts for Command+Slash and Ctrl+Slash', () => {
    expect(keydown({ key: '/' }).preventDefault).toHaveBeenCalledOnce();
    expect(onOpenKeyboardShortcuts).toHaveBeenCalledOnce();

    expect(keydown({ ctrlKey: true, key: '/', metaKey: false }).preventDefault).toHaveBeenCalledOnce();
    expect(onOpenKeyboardShortcuts).toHaveBeenCalledTimes(2);
});

it('ignores modified, composing, and repeated slash events', () => {
    keydown({ altKey: true, key: '/' });
    keydown({ isComposing: true, key: '/' });
    keydown({ key: '/', repeat: true });
    expect(onOpenKeyboardShortcuts).not.toHaveBeenCalled();
});
```

Also return and assert `stopPropagation` from the test helper so a handled slash event proves both browser interception calls.

- [ ] **Step 2: Run the test and confirm RED**

```bash
pnpm exec vitest run sources/hooks/useGlobalKeyboard.test.tsx
```

Expected: failure because `onOpenKeyboardShortcuts` and slash handling do not exist.

- [ ] **Step 3: Implement the smallest hook extension**

Add the optional callback:

```ts
onOpenKeyboardShortcuts?: () => void;
```

Before matching shortcuts, return for `e.isComposing` or `e.repeat`. Add the slash branch beside settings and command palette:

```ts
} else if (isModifierPressed && !e.altKey && key === '/') {
    handler = options.onOpenKeyboardShortcuts;
}
```

Keep `preventDefault()` and `stopPropagation()` conditional on finding a real handler, and add the callback to the effect dependency list.

- [ ] **Step 4: Run the focused test and confirm GREEN**

```bash
pnpm exec vitest run sources/hooks/useGlobalKeyboard.test.tsx
```

- [ ] **Step 5: Commit the hook slice**

```bash
git add packages/happy-app/sources/hooks/useGlobalKeyboard.ts \
    packages/happy-app/sources/hooks/useGlobalKeyboard.test.tsx
git commit -m "feat(app): register keyboard shortcuts hotkey" \
    -m "Co-Authored-By: Codex <codex@openai.com>"
```

---

## Task 3: Build the Typed, Runtime-Aware Shortcut Catalog

**Files:**

- Create: `packages/happy-app/sources/components/KeyboardShortcuts/shortcutCatalog.ts`
- Create: `packages/happy-app/sources/components/KeyboardShortcuts/shortcutCatalog.test.ts`
- Modify: `packages/happy-app/sources/text/_default.ts`
- Modify: `packages/happy-app/sources/text/translations/en.ts`
- Modify: `packages/happy-app/sources/text/translations/ru.ts`
- Modify: `packages/happy-app/sources/text/translations/pl.ts`
- Modify: `packages/happy-app/sources/text/translations/es.ts`
- Modify: `packages/happy-app/sources/text/translations/it.ts`
- Modify: `packages/happy-app/sources/text/translations/pt.ts`
- Modify: `packages/happy-app/sources/text/translations/ca.ts`
- Modify: `packages/happy-app/sources/text/translations/zh-Hans.ts`
- Modify: `packages/happy-app/sources/text/translations/zh-Hant.ts`
- Modify: `packages/happy-app/sources/text/translations/ja.ts`

- [ ] **Step 1: Add canonical translation keys to `_default.ts` and `en.ts`**

Create a top-level `keyboardShortcuts` group with strings for:

```ts
keyboardShortcuts: {
    help: 'Help',
    title: 'Keyboard shortcuts',
    close: 'Close keyboard shortcuts',
    open: 'Open keyboard shortcuts',
    common: 'Common',
    navigation: 'Navigation',
    commandPalette: 'Command palette',
    conversation: 'Conversation and input',
    desktopApp: 'Desktop app',
    openCommandPalette: 'Open command palette',
    openSettings: 'Open app settings',
    toggleLeftSidebar: 'Toggle sessions sidebar',
    toggleRightPanel: 'Toggle details panel',
    closeOrGoBack: 'Close the top layer or go back',
    closeOrGoBackDetail: 'Closes the modal, Zen mode, overlay, then route history',
    moveSelection: 'Move selection',
    runSelected: 'Run selected command',
    closeCommandPalette: 'Close command palette',
    runNumberedResult: 'Run visible result 1–9',
    sendMessage: 'Send message',
    insertNewLine: 'Insert a new line',
    navigateSuggestions: 'Navigate suggestions',
    acceptSuggestion: 'Accept suggestion',
    closeSuggestions: 'Close suggestions',
    stopRunningAgent: 'Stop a running agent',
    pressTwice: 'Press twice within two seconds',
    zoomIn: 'Zoom in',
    zoomOut: 'Zoom out',
    resetZoom: 'Reset zoom',
    commandPaletteDisabled: 'Enable the command palette shortcut in Settings',
}
```

Reuse the existing `settings.reportIssue` string for the help menu instead of adding a duplicate.

- [ ] **Step 2: Use the required translation specialist and update every language**

Have the repository-required i18n-translator agent translate and verify the same key set in all ten files. Preserve established terminology such as `Command`, `Ctrl`, and `Tauri` only where technically necessary; all action labels and annotations must be natural in the target language.

- [ ] **Step 3: Add failing catalog tests**

Define a single runtime input so the pure function is deterministic:

```ts
type ShortcutCatalogContext = {
    commandPaletteEnabled: boolean;
    enterToSend: boolean;
    inTauri: boolean;
    platform: string;
    rightPanelAvailable: boolean;
};
```

Tests must assert:

- `MacIntel` returns symbol keycaps such as `['⌘', 'K']`, `['⌥', '⌘', 'B']`, and `['⌘', '/']`.
- `Win32` returns text keycaps such as `['Ctrl', 'K']`, `['Alt', 'Ctrl', 'B']`, and `['Ctrl', '/']`.
- browser context omits the `desktop-app` section; Tauri includes zoom in/out/reset.
- unavailable right-panel capability omits the right-panel row.
- command-palette-disabled keeps the row but adds the localized annotation.
- Enter-to-Send enabled produces `Enter` for send plus `Shift + Enter` for newline; disabled omits the unsupported send chord and shows `Enter` for newline.
- catalog IDs do not include `new-session` or `command-enter-send`.

- [ ] **Step 4: Run the catalog test and confirm RED**

```bash
pnpm exec vitest run sources/components/KeyboardShortcuts/shortcutCatalog.test.ts
```

- [ ] **Step 5: Implement the pure catalog**

Export typed section/row structures:

```ts
export type ShortcutRow = {
    id: string;
    icon: keyof typeof Ionicons.glyphMap;
    label: string;
    detail?: string;
    alternatives: readonly (readonly string[])[];
};

export type ShortcutSection = {
    id: 'common' | 'navigation' | 'command-palette' | 'conversation' | 'desktop-app';
    title: string;
    rows: readonly ShortcutRow[];
};

export function createShortcutSections(context: ShortcutCatalogContext): ShortcutSection[];
```

Implement one key-token formatter for Mac versus non-Mac presentation. Reuse `getDesktopPanelShortcutPresentation(context.platform)` as the source for the existing sidebar combinations, then convert its ARIA chord tokens to keycap tokens. Keep the catalog declarative and free of event handlers.

- [ ] **Step 6: Run catalog and translation type checks**

```bash
pnpm exec vitest run sources/components/KeyboardShortcuts/shortcutCatalog.test.ts
pnpm typecheck
```

Expected: catalog tests pass and `TranslationStructure` confirms no language is missing a key.

- [ ] **Step 7: Commit catalog and translations**

```bash
git add packages/happy-app/sources/components/KeyboardShortcuts/shortcutCatalog.ts \
    packages/happy-app/sources/components/KeyboardShortcuts/shortcutCatalog.test.ts \
    packages/happy-app/sources/text/_default.ts \
    packages/happy-app/sources/text/translations
git commit -m "feat(app): define localized shortcut catalog" \
    -m "Co-Authored-By: Codex <codex@openai.com>"
```

---

## Task 4: Render the Grouped Keyboard-Shortcuts Modal

**Files:**

- Create: `packages/happy-app/sources/components/KeyboardShortcuts/KeyboardShortcutsModal.tsx`
- Create: `packages/happy-app/sources/components/KeyboardShortcuts/KeyboardShortcutsModal.test.tsx`
- Create: `packages/happy-app/sources/components/KeyboardShortcuts/index.ts`

- [ ] **Step 1: Add failing component tests**

Render two small catalog sections and assert:

- the localized title and close-button accessible label are present;
- section order and row order are preserved;
- each chord token renders in a separate keycap and alternatives are separated visually;
- header and `ScrollView` are siblings so only the body scrolls;
- the panel exposes dialog/modal semantics and the body exposes `keyboard-shortcuts-scroll`;
- pressing the close button calls `onClose` once;
- the close button receives initial focus and focus is restored on unmount.

Mock React Native, Unistyles, icons, and `t()` using the patterns in `SidebarAccountMenu.test.tsx`.

- [ ] **Step 2: Run the modal test and confirm RED**

```bash
pnpm exec vitest run sources/components/KeyboardShortcuts/KeyboardShortcutsModal.test.tsx
```

- [ ] **Step 3: Implement the presentational modal**

Use this structure:

```tsx
<View accessibilityViewIsModal role="dialog" style={styles.panel}>
    <View style={styles.header}>
        <Text style={styles.title}>{t('keyboardShortcuts.title')}</Text>
        <Pressable ref={closeRef} accessibilityLabel={t('keyboardShortcuts.close')} onPress={onClose} />
    </View>
    <ScrollView testID="keyboard-shortcuts-scroll">
        {sections.map(renderSection)}
    </ScrollView>
</View>
```

Use Web `width: 'calc(100vw - 32px)'`, `maxWidth: 720`, `maxHeight: '76vh'`, 14px radius, hairline divider, theme surface/shadow, compact rows, and mono-styled keycaps. Keep the header outside the scroll view. Add a Web focus effect that remembers `document.activeElement`, focuses the close control, keeps Tab focus on the modal's focusable controls, and restores the saved element during cleanup.

Do not add navigation, modal-stack state, or global key handling to this component.

- [ ] **Step 4: Run the focused component test and confirm GREEN**

```bash
pnpm exec vitest run sources/components/KeyboardShortcuts/KeyboardShortcutsModal.test.tsx
```

- [ ] **Step 5: Commit the modal**

```bash
git add packages/happy-app/sources/components/KeyboardShortcuts
git commit -m "feat(app): render keyboard shortcuts reference" \
    -m "Co-Authored-By: Codex <codex@openai.com>"
```

---

## Task 5: Add the Launcher Provider and Root Integration

**Files:**

- Create: `packages/happy-app/sources/components/KeyboardShortcuts/KeyboardShortcutsProvider.tsx`
- Create: `packages/happy-app/sources/components/KeyboardShortcuts/KeyboardShortcutsProvider.test.tsx`
- Modify: `packages/happy-app/sources/components/KeyboardShortcuts/index.ts`
- Modify: `packages/happy-app/sources/components/SidebarNavigator.tsx`
- Modify: `packages/happy-app/sources/components/SidebarNavigator.test.tsx`

- [ ] **Step 1: Add failing provider tests**

Mock `useModal`, `useGlobalKeyboard`, storage settings, `isTauri`, and `useDesktopWorkspaceLayout`. Capture both the hook option and the launcher context. Assert that:

```ts
keyboardOptions?.onOpenKeyboardShortcuts?.();
latestLauncher?.open();
```

both request a custom modal whose component is `KeyboardShortcutsModal`, but a synchronous opening ref plus modal-state inspection allow only one active shortcuts modal. Verify the generated sections receive command-palette preference, `agentInputEnterToSend`, platform, Tauri, and `useDesktopWorkspaceLayout().rightPanelAvailable` context. Verify `isAvailable` is false outside Web or when the desktop workspace is disabled.

- [ ] **Step 2: Run the provider test and confirm RED**

```bash
pnpm exec vitest run sources/components/KeyboardShortcuts/KeyboardShortcutsProvider.test.tsx
```

- [ ] **Step 3: Implement provider/context and deduplication**

Expose:

```ts
type KeyboardShortcutsLauncher = {
    isAvailable: boolean;
    open: () => void;
};

export function useKeyboardShortcutsLauncher(): KeyboardShortcutsLauncher | null;
```

In the provider:

- read `modalState` and `showModal` from `useModal()`;
- derive whether `KeyboardShortcutsModal` is already in the stack;
- mirror that into `openingRef`, as `CommandPaletteProvider` does;
- use a stable `open()` callback that returns unless Web or already opening/open;
- compute the catalog at open time from current preferences and capabilities;
- call `showModal({ type: 'custom', component: KeyboardShortcutsModal, props: { sections } })`;
- register `open` through `useGlobalKeyboard(undefined, { onOpenKeyboardShortcuts: open })`.

- [ ] **Step 4: Mount the provider inside the desktop layout context**

`SidebarNavigator` already lives under `ModalProvider` and owns `DesktopWorkspaceLayoutProvider`. Nest the shortcuts provider inside that layout provider so it can read real panel capabilities while still wrapping both the sidebar and page content:

```tsx
<DesktopWorkspaceLayoutProvider enabled={auth.isAuthenticated && isTablet}>
    <KeyboardShortcutsProvider>
        <SidebarNavigatorContent />
    </KeyboardShortcutsProvider>
</DesktopWorkspaceLayoutProvider>
```

Update `SidebarNavigator.test.tsx` to mock the provider and assert that it wraps the navigator content. Keep `BrowserNavigationShortcuts` under `ModalProvider` so Escape continues to dismiss only the top modal.

- [ ] **Step 5: Run focused provider/hook/layout checks**

```bash
pnpm exec vitest run \
    sources/hooks/useGlobalKeyboard.test.tsx \
    sources/components/KeyboardShortcuts/KeyboardShortcutsProvider.test.tsx \
    sources/components/SidebarNavigator.test.tsx
pnpm typecheck
```

- [ ] **Step 6: Commit the provider integration**

```bash
git add packages/happy-app/sources/components/KeyboardShortcuts \
    packages/happy-app/sources/components/SidebarNavigator.tsx \
    packages/happy-app/sources/components/SidebarNavigator.test.tsx
git commit -m "feat(app): open shortcuts from global provider" \
    -m "Co-Authored-By: Codex <codex@openai.com>"
```

---

## Task 6: Add the Sidebar Help Popover and Rebalance the Footer

**Files:**

- Create: `packages/happy-app/sources/components/SidebarHelpMenu.tsx`
- Create: `packages/happy-app/sources/components/SidebarHelpMenu.test.tsx`
- Modify: `packages/happy-app/sources/components/SidebarAccountMenu.tsx`
- Modify: `packages/happy-app/sources/components/SidebarAccountMenu.test.tsx`
- Modify: `packages/happy-app/sources/components/SidebarView.tsx`
- Modify: `packages/happy-app/sources/components/SidebarView.test.tsx`

- [ ] **Step 1: Add failing help-menu tests**

Model the component after `SidebarAccountMenu` and test:

- the separate `?` trigger has `accessibilityRole="button"`, localized Help label, `aria-haspopup="menu"`, and expanded state;
- opening focuses `sidebar-help-shortcuts-action`;
- Keyboard shortcuts closes the popover, focuses the help trigger, then calls `launcher.open()`;
- Report issue closes the popover and calls `openExternalUrl('https://github.com/wangjs-jacky/happy/issues')`;
- Escape prevents/stops the event, closes, and restores trigger focus;
- the popover is anchored above/right and uses menu semantics.

- [ ] **Step 2: Run the new test and confirm RED**

```bash
pnpm exec vitest run sources/components/SidebarHelpMenu.test.tsx
```

- [ ] **Step 3: Implement `SidebarHelpMenu`**

Give it controlled state like the account menu:

```ts
type SidebarHelpMenuProps = {
    onOpenChange: (open: boolean) => void;
    open: boolean;
};
```

Use a 44px desktop button (never smaller than 40px), `help-circle-outline`, existing surface/divider/radius tokens, and a fixed-width popover extending left from the trigger. Use `flash-outline` for Keyboard shortcuts and `help-buoy-outline` for Report issue. Reuse the existing support URL and `openExternalUrl` behavior.

Before opening the modal from a menu item, focus the stable question-mark trigger so the modal's focus-restoration capture returns to the correct origin instead of the soon-to-unmount menu row.

- [ ] **Step 4: Remove Report issue from the account popover and update its tests**

Delete the account-menu support action/import/callback. Update the destination test to assert profile/settings/account remain and `sidebar-account-help-action` is absent. Keep logout confirmation, Escape, and trigger alignment coverage unchanged. The existing Settings destination remains available in regular/mobile layouts; do not render `SidebarHelpMenu` outside desktop density because a native shortcuts screen is explicitly out of scope.

- [ ] **Step 5: Integrate mutually exclusive footer menus in `SidebarView`**

Replace the account-only boolean with a single controlled state:

```ts
type FooterMenu = 'account' | 'help' | null;
const [footerMenu, setFooterMenu] = React.useState<FooterMenu>(null);
```

Use one full-sidebar dismiss layer whenever either menu is open. In desktop density, render a flex row with the account control taking remaining width and the separate help control at the right edge. In regular density, retain the existing account footer geometry and do not render keyboard help.

- [ ] **Step 6: Update sidebar composition tests**

Mock `SidebarHelpMenu` and assert:

- desktop density renders one account menu plus one help menu;
- regular/mobile density renders account only;
- opening help closes account and opening account closes help;
- the shared outside-press dismiss layer resets the footer-menu state;
- existing command-palette search and Agent-space behavior remains unchanged.

- [ ] **Step 7: Run all footer tests and confirm GREEN**

```bash
pnpm exec vitest run \
    sources/components/SidebarHelpMenu.test.tsx \
    sources/components/SidebarAccountMenu.test.tsx \
    sources/components/SidebarView.test.tsx
```

- [ ] **Step 8: Commit the sidebar integration**

```bash
git add packages/happy-app/sources/components/SidebarHelpMenu.tsx \
    packages/happy-app/sources/components/SidebarHelpMenu.test.tsx \
    packages/happy-app/sources/components/SidebarAccountMenu.tsx \
    packages/happy-app/sources/components/SidebarAccountMenu.test.tsx \
    packages/happy-app/sources/components/SidebarView.tsx \
    packages/happy-app/sources/components/SidebarView.test.tsx
git commit -m "feat(app): add sidebar keyboard help" \
    -m "Co-Authored-By: Codex <codex@openai.com>"
```

---

## Task 7: Run the Two-Layer Regression Suite and Static Verification

**Files:**

- Verify all files changed in Tasks 1–6.

- [ ] **Step 1: Run the focused unit layer**

```bash
pnpm exec vitest run \
    sources/hooks/useGlobalKeyboard.test.tsx \
    sources/components/CommandPalette/CommandPaletteProvider.test.tsx \
    sources/components/KeyboardShortcuts/shortcutCatalog.test.ts \
    sources/components/KeyboardShortcuts/KeyboardShortcutsModal.test.tsx \
    sources/components/KeyboardShortcuts/KeyboardShortcutsProvider.test.tsx \
    sources/components/SidebarHelpMenu.test.tsx \
    sources/components/SidebarAccountMenu.test.tsx \
    sources/components/SidebarView.test.tsx \
    sources/components/SidebarNavigator.test.tsx \
    sources/modal/components/CustomModal.test.tsx \
    sources/utils/desktopNavigationLayout.test.ts
```

Expected: all focused interaction and presentation seams pass.

- [ ] **Step 2: Run the repository integration layer**

```bash
pnpm typecheck
```

Expected: strict TypeScript and all translation structures pass.

- [ ] **Step 3: Check patch hygiene from the worktree root**

```bash
git diff --check
git status --short
git log --oneline origin/main..HEAD
```

Expected: no whitespace errors; only planned files are dirty or committed; root-workspace policy remains intact.

- [ ] **Step 4: Review the delivered behavior against the approved spec**

Confirm from code/tests:

- `Command/Ctrl + ,` owns app settings in Web.
- `Command/Ctrl + /` opens one shortcuts modal and ignores Alt, IME composition, and repeats.
- the `?` footer button, help popover, and modal are keyboard accessible.
- Report issue is no longer duplicated in the PC account menu.
- platform/capability filtering never presents an unusable shortcut.
- Escape/backdrop/close-button behavior uses the existing topmost modal hierarchy.

- [ ] **Step 5: Keep manual visual validation behind the required approval gate**

Do not run `pnpm web` automatically. If the user later approves that exact command or asks for a PR, run it from `packages/happy-app`, verify the footer popover and modal at the same viewport/DPR/zoom, and capture matched before/after evidence for the PR.

- [ ] **Step 6: Resolve any final test-only adjustments in their owning task**

If verification requires a code or test correction, return to the corresponding task, rerun its focused RED/GREEN loop, stage only the exact files reported by `git status --short`, and create a scoped follow-up commit. If verification is clean, make no extra commit.
