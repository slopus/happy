# Project rail return location

The project rail entry used to navigate to bare `/projects`. Desktop conversation navigation can also remove the previous project screen from the stack, so retaining stack parameters alone cannot restore its location.

The focused project screen now records its whitelisted route in existing account-local settings. It pins the effective machine, including when the original URL omitted it. The desktop rail restores that destination; clicking the already active entry leaves it in place. Explicit breadcrumb navigation updates the remembered destination, including returning to all projects. Native navigation keeps its existing behavior.

Only project navigation fields are persisted. External destinations, unrelated query parameters, fragments, arrays and oversized values cannot become a restored rail route. Background/unfocused screens and frozen account runtimes cannot overwrite the remembered destination.

## Validation

The old implementation failed both new sidebar regressions: restoring a saved feature/task route, and clicking the currently active project entry. After integrating the desktop navigation update from main (`0f98275e`), the final implementation passes 206 checks across 16 files, including the OTA runtime contract, and a non-incremental application typecheck.

Cases covered:

- Sidebar returns to the machine, project, feature, task and selected conversation.
- The actual desktop StackRouter removes the project route during conversation navigation and then restores all its original parameters.
- Explicitly choosing a parent or all-projects location replaces the previous deeper destination.
- Account-local settings survive a storage round trip; existing installations default safely.
- Unfocused retained screens and frozen account runtimes do not overwrite state.
- Unicode paths and file references round-trip correctly; invalid saved destinations fall back safely.
- Phone entry behavior is unchanged and disabled native capture does not instantiate browser query APIs.

Rerun from the repository root:

```sh
pnpm --filter happy-app exec vitest run \
  sources/components/SidebarView.test.tsx \
  sources/hooks/useRememberProjectLocation.test.tsx \
  sources/utils/projectReturnLocation.test.ts \
  sources/sync/localSettings.test.ts \
  sources/sync/localSettings.spec.ts \
  sources/sync/persistence.localSettings.test.ts \
  sources/components/goalBoard/useProjectNavigation.test.tsx \
  sources/navigation/desktopModalRouter.test.ts \
  sources/utils/otaRuntimeConfig.test.ts \
  sources/components/goalBoard/ProjectOverviewWorkspace.test.tsx \
  sources/components/goalBoard/projectNavigation.test.ts \
  sources/components/SidebarNavigator.test.tsx \
  sources/components/DesktopSidebarSessionsNavigation.test.tsx \
  sources/hooks/useDesktopWorkspaceLayout.test.tsx \
  sources/navigation/browserNavigationStore.test.ts \
  sources/navigation/browserRouteObserver.test.ts
pnpm --filter happy-app exec tsc --noEmit --incremental false
```

No browser, screenshots, video, production interaction or native-device testing was performed for this change. The interface appearance is unchanged; verification covers the mounted components, focus behavior, navigation reducer and storage contract. PR publication and production deployment are separate stages.
