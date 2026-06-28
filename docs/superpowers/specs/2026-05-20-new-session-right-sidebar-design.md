# New Session Right Sidebar Design

## Goal

Keep the `/new` composer visually centered on desktop while moving new-session configuration into the existing right-sidebar pattern used by active sessions.

## Scope

- Left navigation sidebar remains unchanged.
- The new right sidebar appears only on `/new`.
- The sidebar is shown only when the active-session file sidebar would be supported: web or Mac, window width at least 1100 px, `fileDiffsSidebar` enabled, and zen mode disabled.
- Unsupported screens keep the current `/new` layout, including the inline configuration box above the composer.

## User Experience

On supported desktop layouts, `/new` shows a centered prompt composer in the main content area. Session settings move into a right sidebar with the same width and background treatment as the active-session files/changes sidebar.

The right sidebar contains the same controls currently shown in the `/new` configuration box:

- machine picker
- project path picker
- agent selector
- model selector when available
- effort selector when available
- permission selector when available
- worktree selector when supported
- offline-machine warning

On unsupported layouts, the existing mobile/tablet/narrow behavior is unchanged.

## Architecture

Extract the `/new` configuration UI into a local reusable component inside `packages/happy-app/sources/app/(app)/new/index.tsx`. Render that component either inline above the composer or inside a right-sidebar container depending on a small pure layout helper in `sources/utils/newSessionSidebarLayout.ts`.

The helper keeps the gating testable without rendering the full Expo screen. The `/new` screen reuses the same sidebar width formula and threshold as `SessionView` so active-session and new-session sidebars behave consistently.

## Testing

Add focused unit coverage for the `/new` sidebar layout helper:

- returns enabled on web when the setting is on, zen mode is off, and width is at least 1100 px
- returns disabled when the setting is off
- returns disabled in zen mode
- returns disabled below the minimum width
- returns disabled on unsupported native platforms

Run the new test, app typecheck, and diff hygiene.
