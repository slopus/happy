# Contributing to Happy

Happy is built by engineers who use AI coding tools all day — and we built Happy so we could use them from anywhere. Contributions that make Happy better for that workflow are welcome.

If you don't get a response on your PR or issue, tag **@bra1ndump**.

## Contribution Priorities

We review contributions in this order:

1. **Bug fixes** — crashes, broken flows, data loss
2. **UI touchups** — polish, layout fixes, visual consistency
3. **New features** — new capabilities that serve the core use case
4. **Refactors** — code quality improvements, test coverage
5. **Core refactors** — sync engine, RPC layer, server changes (discuss first)

If your contribution is lower on this list, it may take longer to get reviewed. That's not a reflection of its value — it's just how we triage.

## Issues

We currently can't reply to every issue individually. We review them in bulk using AI-assisted triage. They're useful — keep filing them — but PRs with clear fixes will always get priority.

Every issue should start with a **one-paragraph summary** of the problem. Don't bury the lede in reproduction steps or logs. Lead with what's broken and what you expected.

## Pull Requests

### The Rules

1. **Start with a one-paragraph summary.** What was broken or missing? What does this PR do about it? A human skimming 20 PRs needs to understand yours in 10 seconds.

2. **Show proof it works.** Include a video, screenshots, or actual log output demonstrating the fix in a real running app. The "before" state can be described with words. The "after" must be shown visually. Unit tests passing is not enough — show it working end-to-end.

3. **Address Codex review comments before requesting human review.** We use automated Codex reviews on all PRs. Resolve those first — they catch the obvious stuff so human reviewers can focus on the important stuff.

4. **Keep PRs focused.** One fix per PR. One feature per PR. If you touched something unrelated, split it out.

5. **Core changes need a discussion first.** If your PR touches the sync engine, RPC protocol, encryption, or server — open an issue or Discord thread before writing code. These areas affect every user and need design alignment.

### What Makes a Good PR

- **Show proof it works.** Screenshots, screen recordings, or actual log output demonstrating the fix in a real running app. Unit tests passing is not enough — show it working end-to-end.
- Links to the issue it fixes (if one exists)
- Short, clear title (`fix: voice session stuck in connecting state` not `Update voice.ts`)
- No unrelated changes, no drive-by refactors

## Development Setup

### Prerequisites

- Node.js >= 20
- pnpm (`npm install -g pnpm`)
- Git

### Getting Started

```bash
git clone https://github.com/slopus/happy.git
cd happy
pnpm install
```

### Native mobile apps

- iOS: [happy-ios](../packages/happy-ios/README.md), Swift/UIKit.
- Android: [happy-android](../packages/happy-android/AGENTS.md), Kotlin/Jetpack Compose.
- Shared translations: [JSON catalogs](../packages/happy-i18n/README.md).

Follow each package's build and test instructions. The old Expo app, web export
and Tauri shell have been removed.

### Happy CLI

```bash
pnpm --filter happy build
pnpm --filter happy test
pnpm --filter happy cli:install   # Build + link this workspace as the global `happy` + restart daemon
```

`cli:install` replaces the `happy` binary installed from npm with a symlink to this workspace.
It reuses `~/.happy/` (auth, sessions) — no separate dev home. To undo:

```bash
npm unlink -g happy && npm i -g happy@latest
```

To sandbox dev data, set `HAPPY_HOME_DIR=~/.happy-dev` in your shell before running `happy`.

### Happy Server

```bash
pnpm --filter happy-server standalone:dev   # Local server (no Docker needed)
```

Runs on `localhost:3005` with embedded PGlite. Set the native app's server URL in its settings.

## Project Structure

The monorepo includes:

- **happy-ios** — Native Swift/UIKit client
- **happy-android** — Native Kotlin/Jetpack Compose client
- **happy-wire** — Shared wire schemas
- **happy-cli** — Node.js CLI that wraps Claude Code and Codex
- **happy-server** — Backend for encrypted sync

For architecture details, check the [docs/](.) folder or ask Happy itself — it knows how the project is set up.

## Community

- [Discord](https://discord.gg/fX9WBAhyfD) — best place for questions and discussion
- [Documentation](https://happy.engineering/docs/)
