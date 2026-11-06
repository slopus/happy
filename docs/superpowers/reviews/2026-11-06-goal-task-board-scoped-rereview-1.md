# Tasks 1–3 scoped re-review, round 1

**Final update, approximately 21:56 Asia/Shanghai: all six original findings are closed. Tasks 1–3 pass this scoped code/regression review.** The nested-context follow-up and fresh evidence are recorded at the end. The initial round-1 results below remain as the audit trail.

2026-11-06, approximately 21:52–21:54 Asia/Shanghai. Reviewed the six original findings against current code and regressions, independently of the implementers' reports. Only this report was written; no production access, browser operation, implementation edit or publication.

## Verdict

Five of six findings are closed. **One P2 remains in artifact classification**, so Task 1 is not yet accepted. Task 2 retains its component/unit-scope pass. Task 3's two original findings are closed; its scoped code/regression review passes. This does not claim completed runtime C1–C7 acceptance or Task 4 integration.

## Remaining P2: nested headings discard reference/history/plan context

Location: `packages/happy-cli/src/modules/goalBoard/parser.ts`, `linksOf` (around line 84) and `artifactsOf` relation classification (around lines 148–151).

The fix correctly rejects direct English References/Expected headings and requires an explicit output heading, but `linksOf` retains only the most recent heading. A generic output subheading loses the enclosing reference/history/expected context:

```markdown
## Historical material
### Outputs
[Older report](report.md)
```

**Independently reproduced with a real temporary Goal feature and task:** the existing historical `report.md` still receives `relation: "output"`, `available: true`. The same structure beneath References/Expected sections is vulnerable when the link label itself contains no exclusion keyword.

Carry heading ancestry into artifact classification, or inherit a reference/history/expected restriction until that parent section ends. Add a nested-heading regression and a subsequent independent `## Actual outputs` section to ensure the restriction also resets correctly.

## Closed findings and evidence

| Original finding | Result | Independently inspected / executed evidence |
| --- | --- | --- |
| P1 attachment pathname swap | Closed | `authorizedFiles.ts` opens O_NOFOLLOW, checks device/inode and containment, stages bounded bytes from that FD before asynchronous upload, uses private directory/read-only staged file, and cleans up in finally. Controller routes image/PDF/media through the shared staging path. Re-ran the original loopback HTTP descriptor-swap reproduction using real controller/requestAttachmentUpload/uploadMediaFile: original bytes uploaded, outside bytes not uploaded, staged file removed. |
| P2 reference/plan classified as output | Partially fixed; remains open | Direct reference/expected/unclassified cases pass; nested heading reproduction above still fails semantics. |
| P2 missing nested artifact events | Closed | Parser registers nearest existing authorized parent and ancestors. Watchers reconcile directory device/inode and replace obsolete handles. Ran real-fs regression covering missing file creation, atomic artifact-directory replacement and a subsequent edit. |
| P2 descriptive-label Markdown | Closed | Viewer now uses artifact.path or returned original filename for the extension. Descriptive-label Markdown regression passes and full original preview/source tests remain green. |
| P2 PDF exceeds existing opener cap | Closed | Goal controller applies 10 MiB before staging/preparation. 11 MiB PDF regression asserts RPC failure and no attachment preparation. Existing encrypted PDF lane tests remain green. |
| P2 navigation during save leaves busy state | Closed | Load effect resets isSaving; obsolete-generation guards still prevent an old save overwriting the new file. Regression starts A save, navigates to B, edits B, resolves A, verifies B remains editable and performs a B save. |

Loopback swap reproduction after fix:

```json
{"resultSuccess":true,"uploadedOriginal":true,"uploadedOutsideGoalRoot":false,"stagedCleaned":true}
```

## Fresh targeted validation

CLI:

```sh
pnpm exec vitest run --config src/modules/goalBoard/vitest.config.ts src/modules/goalBoard/goalBoard.test.ts src/api/apiSession.test.ts
```

**68 passed, 1 intentionally skipped** optional installed-feature check; 2 test files. No installed or production data mutation.

App:

```sh
pnpm exec vitest run sources/components/GoalArtifactViewer.test.tsx sources/sync/goalBoardArtifacts.test.ts sources/components/FileViewPanel.test.tsx sources/utils/filePathEncoding.test.ts sources/components/goalBoard/GoalBoardPanel.test.tsx
```

**63 passed**, 5 test files. React test renderer deprecation/act warnings remain nonfailing harness warnings. No full App suite or browser acceptance was duplicated.

Read current implementation and regression cases directly; reports and previous green logs were treated only as navigation aids. Independent loopback/temp-fixture resources were cleaned up.

## Nonblocking coverage opportunities

The shared staging implementation covers all attachment kinds by construction, but the descriptor-swap regression currently exercises media only; image/PDF-specific swap cases would add assurance. The above-limit PDF case is covered; an exact-10-MiB success test and a missing intermediate-directory creation event test would strengthen boundary coverage. These do not reopen the five closed findings.

## Follow-up: nested context closed

Read the final `linksOf` change directly. It now maintains headings by Markdown level, truncating obsolete descendants when a new parent/sibling heading appears; artifact classification receives the full current heading ancestry. Reference/history/expected context therefore survives a nested Outputs heading and ends when a sibling Actual outputs section begins.

Fresh regression command:

```sh
pnpm exec vitest run --config src/modules/goalBoard/vitest.config.ts src/modules/goalBoard/goalBoard.test.ts
```

**18 passed, 1 optional installed-data test skipped**. This includes three parent contexts (`Historical material`, `References`, `Expected deliverables`), nested Outputs, and sibling Actual outputs reset. Scoped `git diff --check` also passed.

Independently re-ran the original nested-history fixture against the final parser, with a sibling current-output section. Observed:

```json
[{"name":"Earlier report","relation":"reference"},{"name":"Current report","relation":"output"}]
```

**No remaining blocking finding among the six reviewed issues.** Prior independent evidence remains applicable to the unchanged staging, PDF, watcher and App fixes: CLI/API 68 passed + 1 skipped before the final three-case parser regression; App 63 passed; loopback descriptor swap uploaded only original bytes and removed the staged file. This acceptance remains scoped to Tasks 1–3 code/regressions and does not replace runtime/browser acceptance or review of Task 4 integration.
