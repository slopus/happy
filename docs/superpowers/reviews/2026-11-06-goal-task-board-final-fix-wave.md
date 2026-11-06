# Goal First task board — final fix wave

Date: 2026-11-06. Worktree: `happy--goal-task-board`, branch `feat/goal-task-board`.

This wave fixes the two independently reproduced P2 findings in `2026-11-06-goal-task-board-final-review.md` and the coordinator's measured large-TypeScript syntax-highlighting bottleneck. Applied systematic-debugging, test-driven-development and verification-before-completion. All three regressions were written and observed failing before product changes. No commit, push, publication, daemon restart, fixture modification or browser operation was performed by this fixer. Runtime browser remeasurement remains with the coordinator.

## 1. Preserve initial task launch inputs across retries

`registerGoalBoardHandlers.ts` now retains a deep-cloned first task snapshot and its canonical feature for each accepted request ID. The existing ApiSessionClient callback therefore rebuilds exactly the same title/prompt/directory on retries, even after an explicit source reread changes title, goal, next step or outputs. Same-ID reuse for a different task or feature is rejected before calling the launcher. Records belong to the session controller, survive feature selection changes, have a hard 128-ID cap, are never evicted into a potentially different retry payload, and clear on dispose. Reaching the cap rejects a new ID; existing IDs remain retryable. No request-ID replacement or daemon idempotence relaxation was added.

The new real-filesystem integration regression uses the actual controller, `goalBoardTaskPrompt` and `createIndependentSessionLauncher`; only daemon I/O is controlled. First send fails after the child exists, task title/goal/next step change, then the same ID succeeds using the original child and byte-identical message/local ID. It also rejects that ID for another task and for the same mapped task selected through a sibling feature.

RED: retry returned `success: false` and title `Changed task title` instead of `success: true`, child `child`, title `Task`.
GREEN: one spawn, two send attempts with identical arguments, original `Prepare report` retained, updated `Review new report` absent from sent content.

## 2. Watch task/navigation parents through deletion and recreation

`parser.ts` reuses the authorized nearest-existing-parent/ancestor registration for document loads and task mapping candidates, before trying to read/resolve the possibly missing source. It covers navigation and mapped task sources as well as artifacts. Existing containment, broken/outside-symlink refusal, bounded navigation/task traversal and the 400-watcher output limit remain in force. No recursive tree scan or polling was added.

The new controller regression removes a mapped sibling task without artifacts, waits for its removal snapshot, drains queued deletion events with one 250 ms delay, recreates the directory/index, then awaits the `review` snapshot from fs.watch. It does not perform an explicit refresh after recreation or query in a loop.

RED: `Missing task recreation fs.watch event` after the event window.
GREEN: recreation received in the final suite in 411 ms including the 250 ms drain delay. The first post-fix combined run hit the initial 2-second event deadline; an isolated run passed. The deadline was aligned with the existing filesystem tests at 4 seconds and split into phase-specific diagnostics. Both subsequent whole focused CLI runs passed (426 ms / 411 ms for this case).

## 3. Bound syntax rendering while preserving full originals

`GoalArtifactViewer.tsx` applies syntax highlighting only through 64 × 1024 characters. Larger code files and Markdown source views pass `language={null}` to the existing shared renderer; no content is truncated or summarized and text remains selectable. Normal Markdown preview remains unchanged; smaller code still uses its language.

The new viewer regression passes approximately 247 KB of TypeScript including begin/end markers, verifies exact full-content delivery with null language and selectable text, then exercises the actual SimpleSyntaxHighlighter and verifies one complete text token instead of thousands of token nodes. It also checks that large Markdown retains full preview content and uses the full plain source when toggled.

RED: expected null language but received `typescript`.
GREEN: exact original text preserved, one actual complete selectable token; Markdown preview/source assertions pass.

The coordinator supplied the pre-fix runtime evidence: 240 KB / 2,600-line TypeScript produced 65,012 DOM nodes, 955.8 ms to full content and an 871 ms long task (plus subsequent 130/203 ms tasks). This report does not invent post-fix browser timings.

## Commands and fresh results

From `packages/happy-cli`:

```sh
pnpm exec vitest run --config src/modules/goalBoard/vitest.config.ts src/modules/goalBoard/goalBoard.test.ts -t 'immutable initial|recreated after'
```

Before fixes: 2 failed, 20 skipped, exit 1. Both failed for the reported behavioral defects.

```sh
pnpm exec vitest run --config src/modules/goalBoard/vitest.config.ts
```

Final: 2 files passed; 74 tests passed, 1 skipped, exit 0. The skipped case is the pre-existing environment-gated installed-feature read, requiring `GOAL_BOARD_REAL_FEATURE`. Final duration 2.29 s. The preceding complete focused run also passed 74 + 1 skipped.

```sh
pnpm run typecheck
```

CLI: `tsc --noEmit`, exit 0.

From `packages/happy-app`:

```sh
pnpm exec vitest run sources/components/GoalArtifactViewer.test.tsx -t 'large code'
```

Before fix: 1 failed, 10 skipped, exit 1, expected null language but received TypeScript.

```sh
pnpm exec vitest run sources/components/GoalArtifactViewer.test.tsx sources/components/SimpleSyntaxHighlighter.test.tsx sources/sync/goalBoardArtifacts.test.ts
```

Final: 3 files passed, 30 tests passed, exit 0 (270 ms). Existing react-test-renderer deprecation notices are emitted; there are no failed assertions.

```sh
pnpm run typecheck
```

App: `tsc --noEmit`, exit 0, including a fresh rerun after strengthening the real-renderer assertion. No generated route repair was needed by this fixer.

From the worktree root, `git diff --check` passed. Earlier full-App/build results belong to the coordinator and were not rerun or claimed here.

## Reusable implementation lessons

- A transport retry ID identifies the first serialized launch payload; source records are mutable and must not silently regenerate that payload after a child may exist. Keep bounded session ownership and reject identity reuse rather than evicting accepted IDs.
- Watching a removable directory is insufficient for recreation. Register authorized parents while the path is still known, including failed/missing loads; let deletion events settle in the regression so buffered events cannot produce a false pass.
- Full original delivery and syntax coloring are separate requirements. Bound token/render complexity and test the actual shared renderer while preserving every source character and selection.
