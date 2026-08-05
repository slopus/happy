# Task context panel acceptance evidence

Case `TASK-CONTEXT-001` adds current-session task context to the existing
Capability Hub without introducing another desktop column.

Visible UI cases: 1

Both screenshots use the same authenticated route, two-session fixture,
encrypted ACP events, `1280 × 720` CSS viewport, device scale factor `1`, and
browser zoom `100%`. The before image was captured from clean `origin/main` at
`35c53847`; the after image was captured from this implementation worktree
rebased onto the same SHA.

| Case | Problem | Before | After |
| --- | --- | --- | --- |
| TASK-CONTEXT-001 | Successful task resources existed in session history but were not visible as task Outputs or Sources in the Capability Hub. | [`task-context-001-before-1280x720.png`](task-context-001-before-1280x720.png) — the same current session and events only populate the legacy Files card. | [`task-context-001-after-1280x720.png`](task-context-001-after-1280x720.png) — the existing Hub now exposes Outputs and Sources with current-session counts and latest items. |

Additional acceptance states:

- [`task-context-empty-state-1280x720.png`](task-context-empty-state-1280x720.png)
  records the explicit empty descriptions before any successful resource event.
- [`task-context-output-detail-1280x720.png`](task-context-output-detail-1280x720.png)
  records the merged file row after a successful `Write` followed by `Edit`;
  the row remains singular and shows `Updated · ×2`.

The screenshots are produced by isolated authenticated Playwright environments
against the real app and local server, rather than a mocked component page.

## Automated flow

The Web E2E creates two encrypted temporary sessions and sends real ACP
`tool-call` plus successful `tool-result` pairs through the local server. It
asserts:

- explicit empty Outputs and Sources states;
- live `Write`, `Edit`, and `WebFetch` projection;
- resource merging (`×2`) without duplicate rows;
- file-detail and external-source click targets;
- no cross-session resource leakage after switching sessions;
- persistence after returning to the original session and reloading.

## Verification

```bash
pnpm --filter happy-app exec vitest --run sources/components/rightPanel/sessionCapabilityHubModel.test.ts sources/utils/taskResourceEvents.test.ts sources/hooks/useAttachmentImage.test.tsx
pnpm --filter happy-app test --run
pnpm --filter happy-app typecheck
pnpm test:e2e:web -- --grep '\[TASK-CONTEXT\]'
pnpm test:e2e:web -- --grep 'PC 从右侧文件列表打开详情'
```

## Validation checklist

- [x] The declared visible Case count equals the number of unique before/after screenshot groups above.
- [x] The visual Case uses comparable route, fixture, viewport, DPR, and scale evidence.
- [x] Unit coverage includes current-session projection, merged updates, and attachment-image session isolation.
- [x] Web E2E covers empty, live-update, click-target, session-switch, and reload behavior.
- [ ] An independent reviewer checked the final rendered PR body and stable image URLs.

Use [`PR_BODY.md`](PR_BODY.md) as the PR description draft. Replace its
`<COMMIT_SHA>` placeholders with the implementation commit SHA before opening
the PR so GitHub renders immutable evidence URLs.
