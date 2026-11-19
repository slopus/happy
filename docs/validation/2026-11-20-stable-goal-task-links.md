# Goal First task identity and conversation links

Status: implementation and local verification complete. Production delivery is tracked separately in the project release record. Ordinary root checkout remains untouched. Implementation branch/worktree: `stable-goal-task-links` / `../happy--stable-goal-task-links`.

## Behavior

Task identity now uses valid archive frontmatter `task_id: GFT-xxxxxxxx`. Paths locate the current archive and are not its stable identity. A task can move between catalogued features/projects on the same machine while retaining that ID. The machine resolves its current location and the ordinary conversation action opens the same conversation in that task's workspace.

Account/server/machine-scoped storage retains immutable session-to-task bindings and observed historical directory aliases. Compatibility links and historical path hashes can establish a legacy association. Missing/deleted tasks, duplicate stable IDs, contradictory bindings, and reused directory aliases fail closed rather than guessing by title or selecting a different task. Duplicate IDs rejected within a feature also remain visible to the machine-wide uniqueness check through `ambiguousTaskIds`.

Task launch receipts and locally retained conversation history use stable state keys. Existing path-keyed state is imported without overwriting a stable receipt. Reused paths can only import old state for their first observed identity; they cannot transfer an old task's receipt to a new task. Verified session bindings take precedence over a coincidental directory in history matching.

Archives without `task_id` retain read compatibility. Explicitly launching a legacy task allocates and writes its persistent ID once. Atomic immutable allocation makes simultaneous launchers share the same ID; the existing durable launch claim then prevents duplicate execution. A reused path with a prior stable owner must receive its own explicit task ID before an old hash can access it. Unique `legacyIds` preserve the task selection when an old route is refreshed after ID assignment.

All discovery is bounded and happens on focus, user actions or existing events; no polling or timers were added. Older daemons that lack the resolver use the previous client behavior. Both updated Web/App code and the machine CLI/daemon are required for the new behavior.

## Verification

- Red/green regressions for stable IDs, cross-project moves and service recreation, symlink compatibility, old hash inputs, duplicate IDs within and across features, directory reuse with and without a new ID, session binding retention, launch concurrency and old route selection.
- CLI Goal Board/catalog/API/runtime suite: **144 passed, 2 existing skipped**, 6 files. Final command: `pnpm --dir packages/happy-cli exec vitest run --config src/modules/goalBoard/vitest.config.ts --maxWorkers 1`.
- App route/link/history/task selection suite: **67 passed**, 4 files. Command: `pnpm --dir packages/happy-app exec vitest run sources/components/goalBoard/SessionWorkspaceLink.test.tsx sources/utils/sessionWorkspaceRoute.test.ts sources/sync/projectGoals.test.ts sources/components/goalBoard/useTaskCardSelection.test.tsx`.
- App and CLI typechecks passed. Shared wire build and CLI atomic build passed. CLI build emitted existing-style bin/empty-chunk/circular-dependency warnings; no production runtime was changed.
- A read-only source probe against the real local archive recovered the reported conversation's renamed task with its correct GFT identity. Its identity storage was temporary and removed afterwards; archive files and production session metadata were not changed by the probe. Final full-catalog probe took about 3.8 seconds.
- Independent code review identified identity ambiguity, reused paths, concurrent allocation, and legacy route-selection gaps. Each received regressions and fixes; final targeted review found no remaining Important issue in the legacy task lookup branch.

An existing macOS `fs.watch` case timed out during earlier suite runs (`publishes real watcher changes once...`, then `observes missing nested artifact creation...`). The former passed in isolation and the final serial full suite passed. No watcher implementation was changed, and these intermittent results are retained rather than described as consistently green.

No browser, Android device, live daemon upgrade, PR or production release was performed. Local service reconstruction proves durable lookup across service instances, not an end-to-end deployment/restart acceptance. Paths moved outside installed authorized archive roots, or deliberately changed/deleted task IDs, cannot be recovered by this contract. Legacy sessions that lost every old path/binding before any observation still require an explicit association rather than a title-based guess.
