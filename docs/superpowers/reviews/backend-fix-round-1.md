# Goal Board Task 1 — fix round 1

2026-11-06, approximately 21:44–21:48 Asia/Shanghai. Implements the four Important findings from `2026-11-06-goal-task-board-tasks1-3-review.md`. No commit, publication, daemon replacement, or mutation of the installed Goal First records.

## Observed RED before the fix

Command:

```sh
pnpm --filter @wangjs-jacky/paws exec vitest run --config src/modules/goalBoard/vitest.config.ts src/modules/goalBoard/goalBoard.test.ts -t '11MiB|pins original|English references|missing nested'
```

All four selected tests failed:

- 11 MiB PDF was accepted (`success:true`), although the existing document viewer permits 10 MiB.
- Swapping the authorized media pathname to an outside-file symlink during a controlled descriptor await uploaded the literal `PRIVATE ROOT BYTES` instead of the authorized original `ID3`.
- English references/unclassified local files were labeled `output` instead of `reference`.
- Creating a previously missing nested artifact did not emit a snapshot; the single 4-second watchdog expired with `Missing artifact fs.watch event`.

## Changes

- `registerGoalBoardHandlers.ts`: PDF stat guard is 10 MiB, before staging/upload. Existing image and streamed media limits stay separate. Upload preparation receives a private staged file rather than a mutable authorized source pathname.
- New `authorizedFiles.ts`: open with `O_NOFOLLOW`, verify resolved containment and the open FD's device/inode against the authorized pathname, enforce the source size limit, and copy bounded bytes from that FD. Staging uses a random private directory (0700), the original basename and a read-only file (0400). Only after the copy finishes can the existing uploader request a network descriptor. Cleanup runs in `finally`, including upload failures.
- `parser.ts`: bounded text reads share the FD identity check. Outputs require explicit produced/output heading context; English reference/input/contract/expected/planned sections and unknown context remain references. Missing authorized originals retain a registered safe candidate path and watch their nearest existing authorized parent plus authorized ancestors. Escaping/broken symlinks do not gain a usable registered path.
- Watcher reconciliation records directory device/inode, replaces watchers after atomic directory replacement, closes obsolete directory handles, and remains event-driven with no polling or timers.
- Covering tests: `packages/happy-cli/src/modules/goalBoard/goalBoard.test.ts`. Added deterministic cases for the four findings plus staged-file cleanup on uploader failure. The swap case checks original bytes, basename, directory/file modes and removal after success. The missing-artifact case checks creation, atomic parent-directory replacement and a subsequent edit through the replacement watcher.

## GREEN and validation

The same four-test command passed **4/4** after the fixes.

Full related backend/API command:

```sh
GOAL_BOARD_REAL_FEATURE='<explicit installed RSI feature>' GOAL_BOARD_REAL_HOME='<explicit installed home>' pnpm --filter @wangjs-jacky/paws exec vitest run --config src/modules/goalBoard/vitest.config.ts
```

Result at approximately 21:47: **69/69 passed** (16 real-filesystem backend tests, including the opt-in installed read; 53 ApiSession tests). PDF encryption/decryption through the existing attachment lane and no chat emission remained green. Installed records: 40 catalog features, exactly 20 RSI tasks (1 running, 19 pending), 27,054-byte snapshot, zero warnings; cold discovery/catalog/parse 43 ms, warm parse 16 ms. These are local parser measurements, not UI/network timings.

After the last watcher-handle pruning change:

```sh
pnpm --filter @wangjs-jacky/paws exec vitest run --config src/modules/goalBoard/vitest.config.ts src/modules/goalBoard/goalBoard.test.ts
pnpm --filter @wangjs-jacky/paws exec tsc --noEmit
```

Result: **15 passed / 1 intentionally skipped** (the opt-in installed-data test); full CLI typecheck passed. `git diff --check -- packages/happy-cli packages/happy-wire` passed.

The upload race test controls the descriptor await through the attachment preparation callback; it uses real files, rename/symlink replacement, FD staging and reads. No real external media upload or daemon launch is performed by these tests.
