# PC Web Primary Navigation Design

## Goal

Give authenticated desktop users a stable global-navigation column beside the existing Projects / Lists / Timeline column, and make Session History a first-class list mode whose selected conversation opens in the existing routed main pane.

## Desktop structure

The permanent drawer becomes a two-column shell while the Expo Router content remains the third, main column:

1. A fixed primary column contains New Session, Inbox, Session Management, Plugins, My Agents, and Session History, plus the existing account/help footer.
2. A resizable secondary column contains the existing Projects / Lists / Timeline switcher and list content. Selecting Session History from the primary column replaces this column's content with the grouped history list.
3. The routed main area is unchanged. History rows use `useNavigateToSession`, so a selection opens the conversation in this area instead of a modal.

The stored desktop panel width continues to describe the secondary session-list column. A fixed primary-column width is added only at the drawer-composition boundary, so resizing still changes the list width and retains the existing storage contract.

## Component boundaries

- `SidebarView` remains the owner of navigation callbacks, plugin/agent modal state, Agent Space behavior, and footer menus. On desktop it composes a primary column and a secondary column; on mobile it preserves the current single-column order.
- `DesktopSidebarSessionsNavigation` keeps ownership of `desktopSidebarMode`. Its mode gains `history`; Projects / Lists / Timeline remain the only tabs in the secondary-column tab strip.
- A reusable `SessionHistoryList` component owns date grouping and row rendering. The existing `/session/recent` page and desktop history mode both render it with page/sidebar visual variants.
- `SidebarNavigator` adds the fixed primary width to the desktop drawer, persistent-header offset, and resize-handle position. Phone drawer width is unchanged.

## Interaction and state

- New Session and Inbox navigate through existing routes.
- Session Management opens the existing command palette when available and falls back to `/session/search`.
- Plugins and My Agents retain their existing modal/sheet behavior.
- Session History sets `desktopSidebarMode` to `history`; the history row navigates through the existing session-selection hook.
- Clicking Projects, Lists, or Timeline exits history mode by setting the corresponding persisted mode.
- Agent Space continues to replace the full sidebar work surface.

## Visual rules

All ordinary, hover/pressed, and selected navigation surfaces use `theme.colors.surface`, `theme.colors.surfacePressed`, and `theme.colors.surfaceSelected`. The primary and secondary columns use theme backgrounds/dividers and introduce no fixed UI colors. The desktop acceptance pass covers the default theme and `ginghamDark`.

## Acceptance cases

- Case 1: desktop shows a distinct primary navigation column with all six destinations.
- Case 2: Projects / Lists / Timeline remain a separate secondary column and switch normally.
- Case 3: Session History replaces the secondary list, and selecting a row opens the conversation in the routed main pane.
- Case 4: existing New Session, Inbox, Session Management, Plugins, and My Agents actions still work.
- Case 5: mobile retains the single-column drawer information structure.
- Case 6: default and `ginghamDark` states have consistent normal, pressed/hover, and selected surfaces.
