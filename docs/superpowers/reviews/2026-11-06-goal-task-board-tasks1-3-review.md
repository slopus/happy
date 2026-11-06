# Goal task board Tasks 1–3 independent review

Reviewed 2026-11-06. Scope: shared wire contract, CLI Goal controller/parser/catalog and ApiSession lifecycle/upload additions; presentational board; original artifact viewer/cache; explicit FileViewPanel refresh and Unicode route helpers. Task 4 hook/SessionView integration is still in progress and is not graded here. No production access or browser work was performed. Source files were not changed by this review.

## Verdict at initial review

- Task 1: **FAIL** until the attachment authorization race, output/reference classification, and missing-artifact event updates are fixed.
- Task 2: **PASS for the inspected component contract and targeted unit tests**. Desktop/native visual, keyboard, real runtime and non-default dark theme acceptance remain to be performed by the overall task; this is not a claim of completed C7.
- Task 3: **FAIL at initial review** for descriptive-label Markdown dispatch and save/navigation busy state. Implementer has begun fixes; final acceptance requires the requested scoped re-review.

## Findings

### P1 — Attachment upload can read a symlink introduced after Goal authorization

Location: `packages/happy-cli/src/modules/goalBoard/registerGoalBoardHandlers.ts:137`–140, connected to `packages/happy-cli/src/api/apiSession.ts:470`–487.

The Goal controller resolves and validates a pathname, then passes that pathname to `prepareAttachment`. The production media adapter stats it, awaits `requestAttachmentUpload` over the network, then `uploadMediaFile` opens the pathname with `createReadStream`. Replacing `clip.mp4` or a parent directory with a symlink during that network wait redirects the actual read outside the authorized Goal projects root. A subsequent `assertCurrent` checks selection lifecycle, not the opened file. The media upload uses the existing plaintext lane, so this can transmit unrelated private bytes.

**Reproduced:** a temporary installed Goal fixture and a loopback HTTP server exercised the real `registerGoalBoardHandlers`, `requestAttachmentUpload`, and `uploadMediaFile`; `prepareAttachment` reproduced ApiSession's stat → request descriptor → upload sequence. The POST handler replaced the previously authorized media file with a symlink to a same-size file outside the Goal root before returning the upload descriptor. Result:

```json
{"resultSuccess":true,"uploadedOutsideGoalRoot":true,"uploaded":"PRIVATE ROOT BYTES"}
```

Fix the ownership of the actual bytes: open and validate a bounded file descriptor before the asynchronous handoff, then upload from that descriptor; or make a bounded private staged copy from a validated descriptor and upload that immutable copy. Another pathname check before the same asynchronous open does not close this race. Apply the protection to image/PDF and media Goal uploads.

### P2 — Same-directory references and planned files become actual outputs

Location: `packages/happy-cli/src/modules/goalBoard/parser.ts:125`–127.

An artifact is treated as an output merely because it lives under the task directory, unless a small Chinese keyword list happens to reject the label/heading. Existing local input or historical files under English `References` / `History` sections become outputs. Links under `Expected deliverables` become outputs even when the files do not exist. This contradicts the approved separation of actual output, references, plans and historical material.

**Reproduced:** a real temporary task index containing:

```markdown
## References
[Input sample](sample.md)
## Expected deliverables
[Planned report](report.md)
```

returned `relation: "output"` for both the existing input and nonexistent planned report. The current tests place references outside the task directory and use Chinese section names, so they do not detect this. Prefer explicit actual-output section evidence with conservative fallback to reference, and recognize the supported record formats in both languages.

### P2 — A missing artifact created in an existing nested directory never updates

Location: `packages/happy-cli/src/modules/goalBoard/parser.ts:128`–132 and `:219`.

Unavailable local links lose their usable path, and only available artifact parents enter `watchDirectories`. If `reports/` already exists and an index links `reports/out.md` before the file exists, the controller watches the task directory but not `reports/`. Creating the original file only emits an event inside `reports/`, so metadata remains unavailable indefinitely until the user explicitly refreshes.

**Reproduced:** after selecting a real temporary feature with the nested missing link, writing `reports/out.md` and waiting a single 350 ms observation deadline yielded:

```json
{"initialAvailable":false,"eventSnapshots":1,"lastAvailable":false}
{"afterExplicitRefresh":true}
```

Watch the nearest authorized existing parent for unavailable local targets without exposing unsafe paths to the client. Also test creation of previously absent intermediate directories.

### P2 — Descriptive Markdown link labels disable Markdown rendering

Initial location: `packages/happy-app/sources/components/GoalArtifactViewer.tsx:49`–50 (before the concurrent fix).

The parser sets artifact `name` to the Markdown link label. Deriving the extension from `artifact.name` means `[验收报告](report.md)` is treated as extensionless code, with no Markdown preview/source toggle. Code links with descriptive labels similarly lose syntax selection. Derive the file type from the authorized path/original filename, while keeping the descriptive label as the title.

**Verified by static producer/consumer inspection.** An implementer has since changed this logic while the review was running; that change has not yet received this reviewer's scoped regression validation.

### P2 — PDF upload limit exceeds the existing opener limit

Initial location: `packages/happy-cli/src/modules/goalBoard/registerGoalBoardHandlers.ts:125`, connected to `packages/happy-app/sources/components/tools/views/FileView.tsx:141` and `sources/sync/attachmentLimits.ts:6`–7.

The initial controller allowed PDF upload up to 50 MiB, but the existing document card rejects anything over 10 MiB. An 11 MiB PDF therefore gets read, encrypted and uploaded, then cannot open. Enforce the established PDF limit before any read or upload, and test the exact threshold.

**Verified by static limit comparison.** Coordinator assigned a fix during this review; scoped regression validation is pending.

### P2 — Navigating during save leaves the next file permanently busy

Initial location: `packages/happy-app/sources/components/FileViewPanel.tsx:158`–163 and save `finally` around `:299` / `:332` (before concurrent fixes).

The new generation guard intentionally prevents an old save's completion from mutating a newly selected file, including skipping `setIsSaving(false)`. The file-load effect resets refreshing and conflicts but did not reset saving. Start saving A, switch to B while the request is pending, and resolve A's save: B keeps `isSaving=true`, disabling refresh/save for the lifetime of the mounted panel.

**Verified by static state/lifecycle inspection.** Coordinator assigned a fix during this review; scoped regression validation is pending.

## Checks run

- CLI targeted command: `pnpm exec vitest run --config src/modules/goalBoard/vitest.config.ts src/modules/goalBoard/goalBoard.test.ts src/api/apiSession.test.ts`: **63 passed, 1 optional installed-feature test skipped**.
- App targeted command: `pnpm exec vitest run sources/components/GoalArtifactViewer.test.tsx sources/sync/goalBoardArtifacts.test.ts sources/components/FileViewPanel.test.tsx sources/components/goalBoard/GoalBoardPanel.test.tsx sources/utils/filePathEncoding.test.ts`: **61 passed**.
- The commands above completed before the concurrent fixes; they establish the reviewed baseline rather than validation of subsequent edits.
- Parser reference classification, missing nested artifact creation, and attachment symlink-swap scenarios were independently exercised through inline TypeScript with temporary filesystem fixtures. All temporary data and loopback server resources were cleaned up.
- Account/server fencing, LRU count/byte eviction, request cancellation, Unicode route round trips, existing media/PDF renderer delegation, and removal of FileViewPanel's periodic rereads were inspected and covered by the existing targeted suites. No new business polling or file tunnel was found in the scoped implementation.

## Important regression tests still needed

1. Swap file/parent symlink after authorization and during descriptor acquisition; assert no outside bytes are read or uploaded across media/image/PDF lanes.
2. English references/history/expected sections, same-directory input, and missing planned files must not become actual output.
3. Missing nested artifact becomes available by event; new intermediate directories and watched-directory replacement recover without user refresh.
4. Descriptive labels for Markdown and source code select rendering by real filename and retain full original content.
5. PDF above 10 MiB fails before attachment preparation; exact-limit PDF remains supported.
6. Navigate while save/force-save is pending and verify the new file can refresh/save after the obsolete completion.

## Additional unverified concern

`watchDirectories` retains watcher entries by pathname and only removes them on `error`. `fs.watch` commonly follows directory inodes, so replacing an entire watched task/artifact directory may leave the map holding a watcher for the old inode. This was not independently reproduced and is not a separate graded finding; include the replacement case in the event regression tests above.
