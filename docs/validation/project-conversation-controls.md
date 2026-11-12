# Project conversation controls

Base: `a69e59587acab2d9ed3068517a9a8a9dcbe2d8a9`.

The task conversation header now exposes a desktop global-conversation action, a close action, and current-session archive/delete actions. Global history has its own label. Close keeps the task, files and saved draft; lifecycle actions use the existing confirmation and metadata flow. Explicit live ownership overrides cached history for both message rendering and management actions.

Trusted machine history enters the ordinary `SessionView` loader instead of waiting behind a second hydration gate. Unassociated URL targets still require ownership verification and expose retry. Errors belong to the selected conversation and disappear when another history entry is selected. Confirmed server 404s and successful deletions persist an account/server-scoped exclusion in the existing MMKV store, independently of history-cache expiry. A history-list omission, connection failure or permission error never creates that exclusion.

## Automated checks

```sh
pnpm --filter happy-app exec vitest run \
  sources/components/goalBoard/ProjectConversationHeader.test.tsx \
  sources/components/goalBoard/useProjectConversation.test.tsx \
  sources/components/goalBoard/ProjectOverviewWorkspace.test.tsx \
  sources/hooks/sessionQuickActionItems.test.ts \
  sources/sync/projectGoals.test.ts \
  sources/sync/mergeProjectTaskHistory.test.ts \
  sources/components/goalBoard/useProjectNavigation.test.tsx \
  sources/sync/projectWorkspaceCache.test.ts \
  sources/sync/projectSessionLinks.test.ts
pnpm --filter happy-app typecheck
```

73 checks passed; typecheck passed. Independent code review was performed separately from implementation.

## Complete App acceptance

Use `packages/happy-app/e2e/fixtures/project-goals/README.md` to start a fresh synthetic account. Browser control uses Ego only. Auth URLs stay private. The fixture uses a real local relay and encrypted RPC; its launcher creates empty relay sessions without a model or production daemon.

| Case | Verified result |
| --- | --- |
| Global scope | Task header enters its parent feature conversation; first open creates one empty session in the feature root. |
| Reuse and drafts | Task and global drafts survive switching; repeating global open and closing/reopening keep the same session without another spawn. |
| Close | The global and task chat panels close while task details remain. |
| Management | Archive closes the panel; reopening exposes Restore. Delete first shows the existing irreversible-action confirmation; Cancel preserves the chat; Confirm removes it and closes the panel. The deleted synthetic session returns HTTP 404; the retained session returns HTTP 200. |
| Ownership | A URL combining one task with another task's session exposes neither its messages nor lifecycle menu. |
| Recovery | A missing URL target shows retry; choosing an existing history item loads chat and removes the old loading/error state. |
| Narrow desktop | At 1100px viewport the chat header is 366px wide; close.right=761 is inside header.right=769. At 1280px viewport, a 452px header also contains every action after responsive layout settles. |
| Deleted history | Automated tests verify that authoritative deletions survive runtime generations and cache eviction, including disk failures. Final complete-browser reload verification stalled in Ego and is unverified. |

No model instructions were submitted. User screenshot preference remained unanswered, so no screenshots or video were collected and no Happy Skills frames were reported. These are DOM, interaction, API-status and automated-test results, not image review or native-device acceptance. Production deployment and phone update loading are separate release steps. The global entry is desktop-only, matching the existing scope workspace boundary.
