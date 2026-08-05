## Summary

- Project successful current-session resource events into Outputs and Sources in the existing Capability Hub.
- Merge repeated updates to one resource row while preserving occurrence count and latest status/time.
- Keep resources isolated by session and make supported files, previews, sites, attachments, and images clickable.
- Reuse the shared task-resource projector for the legacy Images, Artifacts, and Files cards.

## Visual evidence

Visible UI cases: 1

| Case | Problem | Before | After |
| --- | --- | --- | --- |
| TASK-CONTEXT-001 | Successful task resources existed in session history but were not visible as task Outputs or Sources in the Capability Hub. | ![Before: same session and events without task Outputs or Sources](https://raw.githubusercontent.com/wangjs-jacky/happy/<COMMIT_SHA>/docs/pr-evidence/task-context-panel/task-context-001-before-1280x720.png) | ![After: task Outputs and Sources in the existing Capability Hub](https://raw.githubusercontent.com/wangjs-jacky/happy/<COMMIT_SHA>/docs/pr-evidence/task-context-panel/task-context-001-after-1280x720.png) |

Both images use the same authenticated route and fixture at `1280 × 720`, DPR
`1`, and browser zoom `100%`. The before image is clean `origin/main` at
`35c53847`. Replace `<COMMIT_SHA>` above with the implementation commit SHA
before running `gh pr create`; do not use a branch URL.

Additional acceptance evidence:

- [Explicit empty state](https://raw.githubusercontent.com/wangjs-jacky/happy/<COMMIT_SHA>/docs/pr-evidence/task-context-panel/task-context-empty-state-1280x720.png)
- [Merged output detail after Write + Edit](https://raw.githubusercontent.com/wangjs-jacky/happy/<COMMIT_SHA>/docs/pr-evidence/task-context-panel/task-context-output-detail-1280x720.png)

## Validation

- [x] `pnpm --filter happy-app exec vitest --run sources/components/rightPanel/sessionCapabilityHubModel.test.ts sources/utils/taskResourceEvents.test.ts sources/hooks/useAttachmentImage.test.tsx`
- [x] `pnpm --filter happy-app test --run`
- [x] `pnpm --filter happy-app typecheck`
- [x] `pnpm test:e2e:web -- --grep '\[TASK-CONTEXT\]'`
- [x] `pnpm test:e2e:web -- --grep 'PC 从右侧文件列表打开详情'`
- [x] The declared visible Case count equals the number of unique before/after screenshot groups embedded above.
- [x] Every visual Case uses comparable viewport/DPR/scale evidence and a stable image URL once `<COMMIT_SHA>` is replaced.
- [ ] An independent reviewer checked the rendered PR body after `<COMMIT_SHA>` replacement, not only local files or a chat report.
