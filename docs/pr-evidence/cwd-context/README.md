# Composer working-directory context acceptance evidence

Visible UI cases: 2

All screenshots use the same authenticated Agent, current/recent directory
fixture, `1280 × 900` CSS viewport, device scale factor `1`, English locale,
light theme, and browser zoom `100%`. Before images were captured from clean
`origin/main` at `5ceb0b39271411881fb1e8aea84a1337ff508e04`; after images were
captured from this branch rebased onto that SHA.

| Case | Problem | Before | After |
| --- | --- | --- | --- |
| CWD-CONTEXT-001 | The current Agent directory was secondary read-only context, so it was not visible or selectable beside the next message. | [`cwd-context-001-before-1280x900.png`](cwd-context-001-before-1280x900.png) — the composer has no directory control; the path appears only in the secondary Folder card. | [`cwd-context-001-after-1280x900.png`](cwd-context-001-after-1280x900.png) — the composer opens the current path, explicit future-message semantics, folder browsing, and same-Agent recent directories. |
| CWD-CONTEXT-002 | A nonexistent target could only be written into the prompt; Happy neither validated it on the owning Agent nor blocked send. | [`cwd-context-002-before-1280x900.png`](cwd-context-002-before-1280x900.png) — a missing-directory instruction leaves Send enabled and provides no validation. | [`cwd-context-002-after-1280x900.png`](cwd-context-002-after-1280x900.png) — the Agent rejects the missing directory, the composer shows an actionable error, and Send remains blocked. |

The after flow additionally verifies full-path hover disclosure, real
home-rooted folder navigation, recent-directory selection, navigation into a
new continued session, Codex fork-before-spawn RPC ordering and resume IDs,
draft preservation, and the original session retaining its historical
directory.

## Verification

```bash
pnpm --filter happy-app typecheck
pnpm --filter @wangjs-jacky/paws typecheck
pnpm --filter happy-app exec vitest run
pnpm --filter @wangjs-jacky/paws test
pnpm --filter happy-app exec vitest run sources/utils/sessionWorkingDirectory.test.ts sources/hooks/useSessionWorkingDirectory.test.tsx sources/utils/sessionFork.test.ts sources/sync/ops.codexFork.test.ts
pnpm --filter @wangjs-jacky/paws exec vitest run src/modules/common/browseHomeDirectory.test.ts src/claude/utils/claudeSessionFork.test.ts src/api/apiMachine.codexFork.test.ts
pnpm test:e2e:web -- --grep 'CWD-03-01'
git diff --check origin/main...HEAD
```

## Validation checklist

- [x] The declared visible Case count equals the two unique before/after screenshot groups above.
- [x] Both visual Cases use the same fixture, viewport, DPR, locale, theme, and scale.
- [x] The nonexistent-path Case is validated through the real encrypted machine RPC boundary.
- [x] Full suites pass: Happy App `179 files / 1315 tests`; Happy CLI `100 files / 816 tests`.
- [x] Unit coverage includes canonical home containment (including symlink escape rejection), path labels, recent same-Agent directories, provider-ID guards, Agent flavor mapping, and cross-directory Codex/Claude forks.
- [x] Web E2E covers visibility, hover, browse, validation, blocked send, fork-before-spawn continuation RPCs, draft preservation, and unchanged source-session context.
- [ ] An independent reviewer checked the final rendered PR body and immutable image URLs.
