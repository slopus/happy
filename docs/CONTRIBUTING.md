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
- Yarn (`npm install -g yarn`)
- Git

### Getting Started

```bash
git clone https://github.com/slopus/happy.git
cd happy
yarn install
```

### Happy App (Mobile + Web)

```bash
yarn workspace happy-app start          # Expo dev server
yarn workspace happy-app ios:dev        # iOS simulator
yarn workspace happy-app android:dev    # Android emulator
yarn web                                # Browser (shortcut)
yarn workspace happy-app typecheck      # Run after all changes
```

The app has three build variants — all can be installed simultaneously on the same device:

| Variant | Bundle ID | App Name | Use Case |
|---------|-----------|----------|----------|
| Development | `com.slopus.happy.dev` | Happy (dev) | Local development with hot reload |
| Preview | `com.slopus.happy.preview` | Happy (preview) | Beta testing & OTA updates |
| Production | `com.ex3ndr.happy` | Happy | App Store release |

Swap `ios:dev` for `ios:preview` or `ios:production` (same for `android:`).

#### macOS Desktop (Tauri)

```bash
yarn workspace happy-app tauri:dev      # Run with hot reload
yarn workspace happy-app tauri:build:dev
```

### Happy CLI

```bash
yarn workspace happy build
yarn workspace happy test
yarn workspace happy dev                # Run without building (uses tsx)
```

#### Local `happy-dev` Command

To test your local build without overwriting the global `happy`:

```bash
cd packages/happy-cli
yarn link:dev       # Creates global happy-dev symlink
yarn unlink:dev     # Removes it
```

Now `happy` runs the stable npm version, `happy-dev` runs your local build.

#### Stable vs Dev Data Isolation

The CLI keeps stable and dev data completely separate:

| | Stable | Development |
|-|--------|-------------|
| Data | `~/.happy/` | `~/.happy-dev/` |
| Start daemon | `npm run stable:daemon:start` | `npm run dev:daemon:start` |

First time? Run `npm run setup:dev` to create the dev data directory.

### Happy Server

```bash
yarn workspace happy-server standalone:dev   # Local server (no Docker needed)
```

Runs on `localhost:3005` with embedded PGlite. To point the app at your local server:

```bash
EXPO_PUBLIC_HAPPY_SERVER_URL=http://localhost:3005 yarn workspace happy-app start
```

## Project Structure

This is a monorepo with four packages:

- **happy-app** — React Native + Expo mobile/web client
- **happy-cli** — Node.js CLI that wraps Claude Code and Codex
- **happy-agent** — Remote agent control
- **happy-server** — Backend for encrypted sync

For architecture details, check the [docs/](.) folder or ask Happy itself — it knows how the project is set up.

## Community

- [Discord](https://discord.gg/fX9WBAhyfD) — best place for questions and discussion
- [Documentation](https://happy.engineering/docs/)
