## Summary

- Show the current Agent working directory beside the desktop session composer, with full-path hover/click disclosure.
- Let users choose a validated same-Agent recent directory, enter a path, or browse the Agent home directory.
- Continue Codex/Claude context in a new session at the selected directory, while preserving the source session and current draft.
- Canonicalize Agent paths before containment checks, rejecting symlink escapes and preserving honest filesystem errors.
- Reject missing provider continuation IDs, missing/inaccessible/outside-home paths, offline/busy Agents, or unsupported switches with actionable feedback and blocked Send.

## Visual evidence

Visible UI cases: 2

| Case | Problem | Before | After |
| --- | --- | --- | --- |
| CWD-CONTEXT-001 | The current Agent directory was secondary read-only context, so it was not visible or selectable beside the next message. | ![Before: composer without working-directory control](https://raw.githubusercontent.com/wangjs-jacky/happy/<COMMIT_SHA>/docs/pr-evidence/cwd-context/cwd-context-001-before-1280x900.png) | ![After: composer working-directory picker with current and recent paths](https://raw.githubusercontent.com/wangjs-jacky/happy/<COMMIT_SHA>/docs/pr-evidence/cwd-context/cwd-context-001-after-1280x900.png) |
| CWD-CONTEXT-002 | A nonexistent target could only be written into the prompt; Happy neither validated it on the owning Agent nor blocked send. | ![Before: missing-directory prompt remains sendable without validation](https://raw.githubusercontent.com/wangjs-jacky/happy/<COMMIT_SHA>/docs/pr-evidence/cwd-context/cwd-context-002-before-1280x900.png) | ![After: Agent validation error blocks Send](https://raw.githubusercontent.com/wangjs-jacky/happy/<COMMIT_SHA>/docs/pr-evidence/cwd-context/cwd-context-002-after-1280x900.png) |

All images use the same authenticated Agent/session/directory fixture at
`1280 × 900`, DPR `1`, English locale, light theme, and browser zoom `100%`.
The before images are clean `origin/main` at
`5ceb0b39271411881fb1e8aea84a1337ff508e04`. Replace `<COMMIT_SHA>` with
the implementation commit SHA before opening the PR; do not use a branch URL.

## Validation

- [x] `pnpm --filter happy-app typecheck`
- [x] `pnpm --filter @wangjs-jacky/paws typecheck`
- [x] `pnpm --filter happy-app exec vitest run` — 179 files / 1315 tests
- [x] `pnpm --filter @wangjs-jacky/paws test` — 100 files / 816 tests
- [x] `pnpm --filter happy-app exec vitest run sources/utils/sessionWorkingDirectory.test.ts sources/hooks/useSessionWorkingDirectory.test.tsx sources/utils/sessionFork.test.ts sources/sync/ops.codexFork.test.ts`
- [x] `pnpm --filter @wangjs-jacky/paws exec vitest run src/modules/common/browseHomeDirectory.test.ts src/claude/utils/claudeSessionFork.test.ts src/api/apiMachine.codexFork.test.ts`
- [x] `pnpm test:e2e:web -- --grep 'CWD-03-01'`
- [x] Web E2E proves `codex-fork-thread` runs before spawn and that spawn carries the forked `resumeCodexThreadId` plus `parentSessionId`.
- [x] `git diff --check origin/main...HEAD`
- [x] The declared visible Case count equals the two unique before/after screenshot groups embedded above.
- [x] Every visual Case uses comparable fixture/viewport/DPR/scale evidence and immutable image URLs after `<COMMIT_SHA>` replacement.
- [ ] An independent reviewer checked the final rendered PR body and immutable image URLs.
