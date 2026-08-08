# Keyboard Shortcuts Help Design

Date: 2026-08-08
Status: Approved

## Context

Paws PC Web exposes several keyboard shortcuts, but they are currently scattered across tooltips, settings copy, and local component behavior. The command palette also shows shortcut labels that are not always backed by a real global handler. Users therefore cannot reliably discover which shortcuts are available in the current environment.

The requested interaction uses two visual references:

- A desktop shortcut reference panel with a title, close control, grouped rows, action icons, and keycap-style combinations.
- A dedicated question-mark button beside the account footer that opens a compact help menu containing a keyboard-shortcuts entry.

The settings-shortcut change establishes a real `Command/Ctrl + ,` handler for app settings. This design treats that handler as a prerequisite and adds `Command/Ctrl + /` as the direct shortcut-help entry.

## Goals

- Add a discoverable help button to the PC sidebar footer.
- Move the existing report-issue action from the account menu into the new help menu.
- Open a keyboard-shortcuts reference panel from the help menu.
- Open the same panel directly with `Command + /` on macOS and `Ctrl + /` on Windows/Linux.
- Show only shortcuts backed by current behavior in the active runtime.
- Present platform-correct modifier labels and hide Tauri-only actions in a normal browser.
- Match the supplied information hierarchy while preserving Paws theme tokens and desktop visual density.
- Keep keyboard and focus behavior accessible and deterministic.

## Non-Goals

- Do not add shortcut customization or user-remapping.
- Do not implement the currently display-only `Command + N` new-session shortcut.
- Do not add the currently unsupported `Command + Enter` send behavior.
- Do not redesign the full account menu, sidebar, settings page, or command palette.
- Do not copy unrelated help-menu actions from the reference product.
- Do not add a mobile-native shortcuts screen.

## Entry Architecture

### Sidebar footer

In desktop-density sidebar layouts, the footer becomes a horizontal group:

- The existing account trigger remains the primary flexible-width control.
- A separate square question-mark button sits to its right.
- The button uses a minimum `40 x 40px` target, the current sidebar surface treatment, and an accessible label equivalent to “Help”.
- The button exposes `aria-haspopup="menu"`, `aria-expanded`, hover, focus, pressed, and open states.

The account menu keeps:

- Profile
- Settings
- Account
- Sign out

The existing report-issue action moves to the help menu so account and assistance actions are not duplicated.

### Help menu

Clicking the question-mark button opens a compact popover anchored above and right-aligned to the button. It contains:

1. Keyboard shortcuts
2. Report an issue

The popover follows the existing `SidebarAccountMenu` density, border, radius, shadow, and theme tokens. It closes on outside press, `Escape`, or item selection. Opening moves focus to the first item; closing returns focus to the question-mark button unless a selected item immediately opens the shortcuts panel.

### Direct shortcut

`Command + /` or `Ctrl + /` opens the shortcut reference panel from anywhere in authenticated PC Web where the global providers are mounted.

- The keydown handler calls `preventDefault()` and `stopPropagation()` before opening.
- `Alt/Option + Command/Ctrl + /` is not treated as the same shortcut.
- A composing IME event is ignored.
- Repeated or held key events cannot stack duplicate panels.
- Pressing the shortcut while the panel is already open leaves the existing panel in place; `Escape`, the close button, or the backdrop closes it.

## Shortcut Reference Panel

### Container

The panel is a Web-only custom modal rendered through the existing modal system.

- Width: `min(720px, calc(100vw - 32px))`.
- Maximum height: `76vh`, with a minimum `16px` viewport safety margin.
- Position: centered horizontally and above the vertical midpoint, consistent with the command-palette baseline.
- Header: fixed inside the panel with the localized title “Keyboard shortcuts” and a close button.
- Body: independently scrollable so the header and close action remain available.
- Surface: `theme.colors.surface`.
- Border: hairline `theme.colors.divider`.
- Radius: `14px`.
- Shadow and backdrop: reuse the command-palette theme treatment instead of fixed reference-image colors.

### Information hierarchy

Each section contains a muted semibold section label followed by shortcut rows. Each row contains:

- A restrained Paws/Ionicons action icon.
- A localized action label.
- Optional secondary context when a behavior is conditional.
- A right-aligned group of keycaps separated by a small plus sign.

Keycaps use the existing mono typography, a subtle divider-color border, a low-contrast surface background, and consistent minimum height. Rows use dividers instead of card-per-row styling. The design must remain readable in both light and dark themes.

### Catalog contents

The panel derives its rows from a typed catalog rather than duplicating JSX for every entry.

#### Common

- Open command palette — `Command/Ctrl + K`; shown as disabled or annotated when the command-palette preference is off.
- Open app settings — `Command/Ctrl + ,`.
- Open keyboard shortcuts — `Command/Ctrl + /`.
- Toggle left sidebar — `Command/Ctrl + B`; desktop workspace only.
- Toggle right panel — `Option + Command + B` or `Alt + Ctrl + B`; shown only where the panel capability exists.

#### Navigation

- Close or go back — `Escape`; explanation notes that the topmost active layer wins: modal, Zen mode, overlay, then route history.

#### Command palette

- Move selection — `ArrowUp / ArrowDown`.
- Run selected command — `Enter`.
- Close — `Escape`.
- Run visible result 1–9 — `Option/Alt + 1…9`.

#### Conversation and input

- Send — `Enter` when “Enter to Send” is enabled on desktop Web.
- New line — `Shift + Enter` when “Enter to Send” is enabled; otherwise `Enter` inserts a newline.
- Navigate suggestions — `ArrowUp / ArrowDown`.
- Accept suggestion — `Enter / Tab`.
- Close suggestions — `Escape`.
- Stop a running agent — press `Escape` twice within the existing two-second confirmation window.

#### Tauri desktop only

- Zoom in — `Command/Ctrl + +`.
- Zoom out — `Command/Ctrl + -`.
- Reset zoom — `Command/Ctrl + 0`.

Normal browser sessions omit the Tauri section because browser zoom remains browser-owned behavior.

## Platform Presentation

The catalog receives runtime context and formats keycaps accordingly:

- macOS: `⌘`, `⌥`, `⇧`, `↑`, `↓`, `↵` where the symbol remains immediately understandable.
- Windows/Linux: `Ctrl`, `Alt`, `Shift`, `↑`, `↓`, `Enter`.
- Text labels remain localized; key names remain conventional platform terms.
- Runtime capability decides whether desktop workspace, right-panel, command-palette, Enter-to-Send, and Tauri-only rows are visible or annotated.

The catalog reuses `getDesktopPanelShortcutPresentation` for the existing left/right-panel combinations and adds only the general key formatter needed by the panel. Existing sidebar tooltip structure is not refactored in this change.

## Component Boundaries

### `KeyboardShortcutsProvider`

- Owns the modal launcher context.
- Exposes `open()` to the sidebar help menu.
- Registers the `Command/Ctrl + /` callback through `useGlobalKeyboard`.
- Guards against duplicate modal opens.
- Lives under the existing `ModalProvider` in the authenticated root layout.

### `KeyboardShortcutsModal`

- Renders the header, close action, scrollable sections, rows, and keycaps.
- Receives the typed catalog and runtime context.
- Contains no navigation or global keyboard registration.

### `shortcutCatalog`

- Defines stable IDs, section IDs, localization keys, icons, key combinations, and availability rules.
- Contains presentation metadata only; it does not execute commands.
- Excludes known display-only or unsupported combinations.

### `SidebarHelpMenu`

- Owns the question-mark trigger, popover state, focus restoration, and outside/Escape dismissal.
- Calls the shortcuts launcher for the first item.
- Reuses the current support URL behavior for the report-issue item.

### Existing integrations

- `SidebarAccountMenu` removes its report-issue row.
- `SidebarView` renders the account trigger and help trigger as a desktop footer group.
- `useGlobalKeyboard` gains an optional `onOpenKeyboardShortcuts` callback and retains the existing settings, command-palette, and panel callbacks.

## Interaction And Accessibility

- The help trigger and every menu/modal control are keyboard focusable and have explicit accessible names.
- The help popover uses menu semantics and keeps the visual focus state visible.
- The modal announces its title, traps focus while open through the existing modal infrastructure, and restores focus to the originating control or previously focused element after close.
- `Escape` closes only the topmost layer.
- Backdrop clicks close the shortcut panel without activating background content.
- Long content scrolls inside the panel; background scroll does not move through the modal.
- Hover is never the only way to discover the help entry or any shortcut.

## Error And Edge Handling

- No network request is needed to open the help menu or shortcuts panel.
- Failure to open the external issue URL keeps existing external-link error behavior.
- Unknown platform strings fall back to `Ctrl/Alt` labels.
- If a capability is unavailable, its row is omitted rather than shown as an unusable command, except the disabled command-palette preference, which is annotated because users can re-enable it.
- Rapid repeated `Command/Ctrl + /` presses open at most one modal.

## Testing

Automated tests use focused behavior seams:

1. `useGlobalKeyboard`: `Command/Ctrl + /` prevents browser default behavior and invokes `onOpenKeyboardShortcuts`; modified variants do not.
2. `KeyboardShortcutsProvider`: global and sidebar launchers open one modal and do not stack repeated opens.
3. `SidebarHelpMenu`: question-mark trigger, menu actions, outside/Escape close, and focus restoration.
4. `shortcutCatalog`: macOS versus Windows/Linux labels, browser versus Tauri filtering, and conditional Enter-to-Send content.
5. `KeyboardShortcutsModal`: title, group order, keycap rendering, scrolling container, close action, and accessible modal semantics.
6. Existing account-menu tests: report-issue removal does not affect profile, settings, account, logout, or Escape behavior.

Static verification:

- Focused Vitest suites.
- Full Happy App TypeScript check.
- `git diff --check`.

If the work becomes a PC UI PR, the PR must include separate before/after evidence for:

- Help button and popover.
- Shortcut reference panel.

Both evidence groups must use matching viewport, DPR, zoom, and crop conditions.

## Expected Implementation Scope

Expected files are:

- `packages/happy-app/sources/hooks/useGlobalKeyboard.ts`
- `packages/happy-app/sources/hooks/useGlobalKeyboard.test.tsx`
- `packages/happy-app/sources/components/KeyboardShortcuts/*`
- `packages/happy-app/sources/components/SidebarHelpMenu.tsx`
- `packages/happy-app/sources/components/SidebarHelpMenu.test.tsx`
- `packages/happy-app/sources/components/SidebarAccountMenu.tsx`
- `packages/happy-app/sources/components/SidebarAccountMenu.test.tsx`
- `packages/happy-app/sources/components/SidebarView.tsx`
- `packages/happy-app/sources/components/SidebarNavigator.tsx`
- All supported translation files for newly visible strings.

No server, database, native module, OTA runtime, or CLI change is required.
