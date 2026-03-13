# Upstream Contribution Plan

31 commits since diverging from upstream. Each PR below should be done in its own conversation — cherry-pick onto a branch off `fork-upstream/main`, push to the fork, open PR against `slopus/happy`.

## Git Setup

- `origin` → `EricSeastrand/happy.git` (our private working copy)
- `fork-upstream` → `EricSeastrand/happy-1.git` (real GitHub fork, for PRs)
- `upstream` → `slopus/happy.git` (the upstream repo)
- Fork is in sync with upstream as of 2026-03-13
- Divergence point: `d343330c`

## Workflow (per PR)

1. `git checkout -b <branch-name> fork-upstream/main`
2. `git cherry-pick <commit(s)>`
3. Resolve any conflicts, verify typecheck passes
4. `git push fork-upstream <branch-name>`
5. `gh pr create --repo slopus/happy --head EricSeastrand:<branch-name>`

---

## Tier 1 — Ready to go (no modifications needed)

### PR 1a: Overscroll bounce
- [x] Submitted — [PR #852](https://github.com/slopus/happy/pull/852) (open, awaiting review)
- Branch: `fix/mobile-web-overscroll`
- Commits:
  - `690ac595` fix(happy-app): disable overscroll bounce and pull-to-refresh on web
- Files: theme.css

### PR 1b: Message/table overflow
- [x] Submitted — [PR #853](https://github.com/slopus/happy/pull/853) (open, awaiting review)
- Branch: `fix/mobile-web-message-overflow`
- Commits:
  - `540579ae` fix(happy-app): message content overflow on mobile web
  - `780231e7` fix(happy-app): prevent table content from overflowing message layout
- Files: MessageView.tsx, MarkdownView.tsx
- Notes: These two commits depend on each other (both touch same files).

### PR 1c: Enter key on mobile web
- [x] Submitted — [PR #854](https://github.com/slopus/happy/pull/854) (open, awaiting review)
- Branch: `fix/mobile-web-enter-key`
- Commits:
  - `f493932b` fix(happy-app): don't intercept Enter on mobile web touch devices
- Files: AgentInput.tsx

### PR 2: Error boundaries
- [x] Submitted — [PR #847](https://github.com/slopus/happy/pull/847) (open, awaiting review)
- Branch: `fix/error-boundaries`
- Commits:
  - `8eb870f1` fix(happy-app): add error boundaries to contain render crashes
  - `714c8113` fix(happy-app): harden todos handling and expand error boundaries
  - `e988b145` fix(happy-app): add error boundaries to ChatList and MainView tabs
- Files: ErrorBoundary.tsx (new), SessionView.tsx, ToolView.tsx, ActiveSessionsGroup(Compact).tsx, SessionsList.tsx, ChatList.tsx, MainView.tsx, reducer.ts, 11 translation files
- Notes: Creates a new ErrorBoundary component, wraps crash-prone areas. Touches translations for error strings.

### ~~PR 3: CLI head-of-line blocking fix (GitHub #639)~~
- [x] Covered — already submitted by davidrimshnick as [PR #699](https://github.com/slopus/happy/pull/699) (open, not yet merged)
- Our commit `b37b43c4` was a cherry-pick of their fix into our fork. Nothing for us to submit.

### PR 4: CLI SDK message forwarding
- [x] Submitted — [PR #843](https://github.com/slopus/happy/pull/843) (open, awaiting review)
- Branch: `fix/clauderemote-nonblocking-nextmessage`
- Commits:
  - `d38de099` fix(happy-cli): unblock SDK messages while waiting for user input
- Files: claudeRemote.ts
- Notes: Different layer than PR 3 (claudeRemote vs OutgoingMessageQueue). Stands alone.

### PR 5: System prompt options rewrite
- [ ] Done
- Branch: `refactor/system-prompt-options`
- Commits:
  - `ed908f2a` refactor(happy-app): rewrite system prompt options rules for clarity
- Files: systemPrompt.ts
- Notes: Pure text change. Replaces verbose instructions with concise rules.

### PR 6: Type safety for nullable content
- [x] Submitted — [PR #849](https://github.com/slopus/happy/pull/849) (open, awaiting review)
- Branch: `fix/nullable-content-type-safety`
- Commits:
  - `cc9ee840` fix: type safety for nullable content fields
- Files: typesRaw.ts, runAcp.ts
- Notes: Fixes crash from empty tool_result content arrays (infinite re-fetch loop).

### PR 7: RPC error details
- [x] Submitted — [PR #848](https://github.com/slopus/happy/pull/848) (open, awaiting review)
- Branch: `fix/rpc-error-details`
- Commits:
  - `6bd6f9fb` fix(happy-app): include server error details in RPC failure messages
- Files: apiSocket.ts
- Notes: One-liner. Surfaces server error messages instead of swallowing them.

### PR 8: Prometheus message size metrics
- [x] Submitted — [PR #851](https://github.com/slopus/happy/pull/851) (open, awaiting review)
- Branch: `feat/prometheus-message-histograms`
- Commits:
  - `fc4e4dba` feat(happy-server): add Prometheus message size histograms
- Files: v3SessionRoutes.ts, metrics2.ts
- Notes: Adds histogram tracking. Server-side only.

---

## Tier 2 — Needs cleanup before PR

### PR 9: Dark mode / palette consolidation
- [ ] Done
- Branch: `feat/dark-mode-palette`
- Commits:
  - `da24a334` feat(happy-app): consolidate color palette and fix dark mode visibility
  - `b06a13d4` fix(happy-app): add dark mode borders to ItemGroup cards and Item dividers
  - `2f1d5d66` fix(happy-app): add dark mode borders to ItemGroup cards and Item dividers
- Files: 25+ files (palette.ts, theme.ts, ItemGroup.tsx, Item.tsx, many component files)
- Cleanup needed:
  - Verify palette.ts exists in upstream or must be included
  - Check that new hex values don't conflict with upstream's intended theme
  - Large diff — may want to test against upstream's current state

### PR 10: iOS PWA status bar fixes
- [ ] Done
- Branch: `fix/ios-pwa-status-bar`
- Commits:
  - `4f808e57` fix(happy-app): web theme colors and status bar styling
  - `80a9da52` fix(happy-app): use default status bar style to fix invisible iOS clock
  - `50d279b4` fix(happy-app): fix iOS PWA status bar text becoming invisible
- Files: +html.tsx, app.config.js, SessionView.tsx, StatusBarProvider.tsx
- Cleanup needed:
  - Depends on PR 9 (palette hex values in +html.tsx and app.config.js)
  - Must go after PR 9 or be rebased to work standalone

### PR 11: Webapp Dockerfile build arg
- [ ] Done
- Branch: `feat/dockerfile-server-url`
- Commits:
  - `e4a5ed6a` feat(docker): add HAPPY_SERVER_URL build arg to webapp Dockerfile
- Files: Dockerfile.webapp
- Cleanup needed:
  - Verify Dockerfile.webapp exists in upstream

---

## Tier 3 — Not upstreamable (local/private)

These stay in our private fork only. They reference homelab infrastructure, local Whisper deployment, or private dev tooling.

- `76909382` feat(voice): dual-mode voice (hardcodes whisper.seas.house)
- `3d25d8d5` vocabulary hints to Whisper requests
- `a56bd6e8` optimize dictation audio for low-bandwidth
- `92d4ce94` dev tooling and whisper tunnel infra (CLAUDE.md, dev.sh, whisper-tunnel/)
- `e97f4b99` lock nginx proxy to transcription endpoint (whisper-tunnel/)
- `4e546903` bundle whisper STT into compose stack (whisper-tunnel/)
- `9c7957be` whisper-tunnel docs and nginx DNS fix
- `73d676ac` whisper-tunnel OOM protection
- `ef62952b` deploy and rollback scripts (.deploy/)
- `6f6b599f` dev CLI wrapper and rebuild script
- `610f29bf` dev workflow and investigation notes (markdown docs)
