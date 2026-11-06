# Goal First task board — final independent branch review

Reviewed on 2026-11-06 against base `f7fbf513922bb4ff1c63db36425ce13aab55765d`, branch `feat/goal-task-board`, including uncommitted and intent-to-add product files in `.superpowers/sdd/2026-11-06-goal-task-board/final-review-diff.patch`. Read the design, implementation plan, SDD ledger and prior scoped re-review, then inspected current implementation and the existing daemon/session/attachment dependencies. Applied the requesting-code-review workflow as the independently dispatched reviewer.

**Verdict: changes required. Two reproducible P2 findings; no confirmed P1.** The six earlier scoped findings remain closed. This report does not claim completed browser/native acceptance or a real daemon/model launch; the coordinator owns runtime/performance acceptance and the full-App fixture deliberately stubs task launching.

## P2 — Preserve the first launch payload across retries

Primary location: `packages/happy-cli/src/api/apiSession.ts:214` (the `startTask` callback constructs a fresh title/prompt for each call). Related: `packages/happy-cli/src/modules/goalBoard/registerGoalBoardHandlers.ts:164`, `packages/happy-app/sources/sync/goalBoard.ts:143`, and existing `packages/happy-cli/src/daemon/independentSessions.ts:39`.

The App correctly retains `requestId` after an initial-send failure, including when the daemon has already created a child. However, each retry selects the latest task snapshot and rebuilds `goalBoardTaskPrompt`. The daemon rejects the same request ID when *any* serialized launch input differs. If the task's next step, goal, title, linked outputs or availability changes before retry, every retry is rejected with `requestId was already used for a different task`. This also affects an uncertain successful response if the source changes before the transport retry. Reloading to obtain a new request ID can create another child instead of repairing the first one.

Independent reproduction used real temporary Goal records, the actual controller, actual prompt builder and actual `createIndependentSessionLauncher`; only spawn/send dependencies were controlled:

1. Read a mapped task with next step `Prepare report`.
2. Start request `stable-id`; spawn returns `child`, first send throws `temporary send failure`.
3. Change its task index next step to `Review new report`, then read the feature again.
4. Retry the identical Goal RPC identity (`featurePath`, `taskId`, `requestId`).

Observed:

```json
{
  "first": {"success": false, "sessionId": "child", "title": "Task", "error": "temporary send failure"},
  "retry": {"success": false, "title": "Task", "error": "requestId was already used for a different task"},
  "sends": 1,
  "spawns": 1
}
```

Preserve the immutable initial launch payload for a retryable request, with bounded ownership and cleanup; keep changed-request identity checks for attempts to reuse an ID for a different task. Add a regression across controller → prompt construction → daemon launcher that changes the source after the first failed send and verifies retry sends to the original child exactly once. Do not solve this by minting a new request ID after a partial failure.

## P2 — Keep watching the authorized parents of cross-feature task sources

Primary location: `packages/happy-cli/src/modules/goalBoard/parser.ts:172` and `:178`–`:187`; the returned watcher set is assembled at `:249`–`:251`.

Task document loading registers the task directory, while the fallback registers only the selected feature's own `tasks` directory. A G-mapped task in a sibling feature therefore has no watcher on its containing sibling `tasks` directory. Once that task directory is removed, the refresh drops its entry and closes its old watcher. Recreating the same directory/index later produces no event on the remaining watched directories, so the task remains missing and counts stay wrong until an explicit refresh. This gap remains after the earlier artifact-directory watcher fix because that ancestor registration is used for artifacts, not task/navigation sources.

Independent real-filesystem/controller reproduction:

1. `all/index.md` links `[G01](../batch/tasks/one/index.md)` and `[Batch](../batch/index.md)`; the task initially has status `running`, with no artifacts.
2. Read `all`, remove `batch/tasks/one`, and wait for the zero-task removal snapshot.
3. Allow already-queued filesystem events to drain using one 250 ms delay, then recreate the directory/index with status `review`.
4. Observe one 500 ms event window, then perform a single explicit read.

Observed:

```json
{"receivedRecreationEvent":false,"snapshotsBeforeExplicitRefresh":0,"explicitRefreshTasks":1,"explicitRefreshStatus":"review"}
```

Register authorized existing parents/ancestors for task and navigation sources, including missing sources, within the existing watcher bound. A regression must let the removal event settle before recreating the directory; immediate recreation can accidentally pass because buffered deletion events trigger another read. No polling is needed.

## Specification compliance and quality assessment

| Area | Assessment |
| --- | --- |
| Catalog, true G mappings, status and dedup | Implemented with bounded traversal and explicit unknown status; real 20-task fixture and earlier parser tests cover the central contract. Missing/recreated cross-feature sources need the P2 fix above. |
| Goal/problem/stage/current outputs | Detail priority follows the spec. Actual, planned and reference sections remain distinct; inherited historical/expected headings and actual commit/URL outputs are handled by the reviewed final parser. |
| Original files and security | Registered artifact IDs, realpath containment, FD/inode validation, bounded text reads, private FD-backed staging and PDF cap are consistent across controller/uploader boundaries. Existing full-original Markdown/source, code and attachment lanes are reused. No new tunnel or automatic media upload was introduced. |
| Session lifecycle | New/continue intent, compound feature/task association, retained request IDs, child/parent metadata repair and account/epoch fences are present. The immutable-payload retry P2 blocks complete C5 acceptance. The existing daemon launcher enforces parent flavor/account constraints; its real production launch was not executed in this review. |
| Metadata, hooks and caches | Hook generations reject late catalog/read/navigation results; reconnect causes an explicit fresh read. Artifact cache is bounded by entries/bytes, launch records by count, and metadata-lock entries release when unused. SessionView content is keyed by session ID. |
| No idle polling and performance design | No new periodic board/file reads; the old FileViewPanel five-second whole-file poll was removed. Filesystem event drain, bounded catalogs/snapshots/watchers, lazy viewer/panel imports and stable snapshot identity are appropriate. Existing bounded post-create hydration retries remain; this is not a claim that the entire session system is timer-free. Runtime long-task/large-file measurements remain with the coordinator. |
| Layout, theme, keyboard and drafts | Reuses the existing desktop/drawer surface; semantic theme tokens, task-detail focus/scroll reset, trigger focus restoration, Escape handling and native artifact Back handling are present. Main draft ownership remains in the existing per-session composer. Browser/native behavioral acceptance is separate from this code assessment. |

### Circular module warning

The `catalog → parser → authorizedFiles → catalog` cycles are real structural coupling, but no blocking runtime defect was found: the imported functions are used from function bodies after initialization, and no cycle-dependent top-level call reads an uninitialized binding. Both independent reproductions imported and executed these modules successfully, consistent with the reported successful CLI build. Extracting path containment and bounded-read primitives into dependency-leaf modules would simplify maintenance, but the warning alone is not a release blocker.

## Evidence and scope

Only this report was added; no product source was edited, no production service/daemon was changed, and no browser tool or release operation was used. Temporary reproduction homes were removed and controllers disposed. Volume mount identity/writeability was verified before writing the report.

The two reproductions above were independently executed in this review. Existing targeted suites and full-App/typecheck results were read as supporting evidence rather than rerun unnecessarily. The prior scoped review provides independent evidence for its six repaired findings. The coordinator subsequently reported 4038 App tests passing, generated route declarations restored and App typecheck passing; those are coordinator results, not fresh runs by this reviewer.

After fixing both P2 items, rerun the focused new regressions and the affected CLI/API suite, then request scoped independent re-review. Complete the coordinator's runtime/performance acceptance separately before claiming the entire feature accepted.
