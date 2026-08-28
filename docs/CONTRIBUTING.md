# Contributing to Paws

Paws is an independently maintained, open-source remote-control client for AI coding agents. Contributions should strengthen the core experience: reliable remote sessions, clear control transfer, private synchronization, and self-hosting that a developer can operate without hidden infrastructure.

## Before You Start

- Repository: <https://github.com/wangjs-jacky/happy>
- Primary branch: `main`
- Node.js: 20 or 24
- Package manager: `pnpm@10.11.0`
- Product name: **Paws**
- Primary CLI command: `paws`; `happy` remains a compatibility alias
- Internal `happy-*` package names and `HAPPY_*` environment variables are intentional compatibility identifiers

Paws does not routinely merge or rebase from the historical upstream repository. Base changes on this repository's `main` and evaluate any third-party implementation as a focused port.

## Contribution Priorities

1. Data loss, privacy, security, broken upgrades, and session lifecycle bugs
2. Reliability of pairing, daemon startup, reconnect, permissions, attachments, and notifications
3. Accessibility, navigation, and focused UI polish
4. Features that strengthen the remote-agent control loop
5. Refactors with measurable maintainability or test improvements

Discuss protocol, encryption, storage migration, native runtime, or daemon lifecycle changes before implementing them. Those areas affect existing installations and may require coordinated App, CLI, Server, APK, or OTA changes.

## Isolated Worktree Workflow

Keep the root checkout clean and aligned with `origin/main`. Do all work in a sibling worktree:

```bash
cd ~/jacky-github/happy
git switch main
git fetch origin
git reset --hard origin/main

git worktree add ../happy--<topic> -b <topic> main
cd ../happy--<topic>
pnpm install
```

Do not symlink a root `node_modules` directory into the worktree. pnpm reuses its global store automatically.

## Pull Requests

A good PR:

- starts with a short problem and solution summary;
- stays focused on one feature, bug, or maintenance outcome;
- lists exact verification commands and results;
- includes screenshots, video, logs, or an OTA stamp for user-visible behavior;
- calls out native, runtime, protocol, storage, security, or migration impact;
- updates current documentation in the same PR when behavior or commands change.

Open PRs against `main`:

```bash
git push -u origin <topic>
gh pr create --repo wangjs-jacky/happy --base main --head <topic>
```

## Project Structure

| Path | Package | Responsibility |
|---|---|---|
| `packages/happy-app` | `happy-app` | Expo / React Native Paws App for Android, iOS structure, web, and desktop experiments |
| `packages/happy-cli` | `@wangjs-jacky/paws` | Paws CLI, daemon, provider runners, MCP bridge, local state, and synchronization |
| `packages/happy-server` | `happy-server-self-host` | Self-host sync relay, API, realtime transport, PGlite/Postgres, and blob storage |
| `packages/happy-agent` | `happy-agent` | Remote agent-control CLI |
| `packages/happy-wire` | `@slopus/happy-wire` | Shared schemas and wire types; package name retained for compatibility |
| `packages/image-gateway` | `happy-image-gateway` | Public/native image-generation gateway logic |
| `packages/codium` | `codium` | Desktop and experimental client surfaces |
| `packages/happy-app-logs` | `happy-app-logs` | App log development helper |

## Verification

Run checks for the packages you changed. Before merging a cross-package or release-sensitive change, run the full workspace suite:

```bash
pnpm -r --if-present typecheck
pnpm -r --workspace-concurrency=4 --if-present test -- --run
```

Common focused checks:

```bash
pnpm --filter happy-app typecheck
pnpm --filter happy-app exec vitest run <test-file>

pnpm --filter @wangjs-jacky/paws typecheck
pnpm --filter @wangjs-jacky/paws test
pnpm --filter @wangjs-jacky/paws build

pnpm --filter happy-server-self-host typecheck
pnpm --filter happy-server-self-host test
```

Do not start Expo/Metro, a simulator, an emulator, Tauri dev, or a real device unless that validation was explicitly requested. For App changes that can ship through Expo Updates, the repository workflow publishes a per-PR preview OTA. The automatic preview and production workflows skip native-sensitive diffs; native or runtime changes require a new matching binary before a manual OTA dispatch.

## App Variants

| Variant | Package / bundle ID | App name | OTA channel | Runtime |
|---|---|---|---|---|
| Development | `build.paws.dev` | `Paws (dev)` | `preview` | `22` |
| Preview | `build.paws.preview` | `Paws (preview)` | `preview` | `22` |
| Production | `build.paws` | `Paws` | `production` | `23` |

Treat `packages/happy-app/ota-runtime-versions.json` as the runtime source of truth. Changing package IDs, Expo plugins, permissions, update URLs, or runtime versions requires a new native build.

## Documentation and Naming

- Use **Paws** in current product-facing prose.
- Keep exact code names such as `happy-app`, `happy-server-self-host`, `@slopus/happy-wire`, `~/.happy`, `HAPPY_SERVER_URL`, and the `happy` compatibility command.
- Do not mechanically rewrite historical `docs/plans`, `docs/research`, `docs/experimental`, or protocol records.
- Update English and Chinese onboarding together when installation or distribution changes.

For architecture and setup, start with [`docs/README.md`](README.md) and [`docs/getting-started.md`](getting-started.md).

For plugin manifests, encrypted configuration, trusted adapters, lifecycle, and release requirements, follow [`docs/plugin-development.md`](plugin-development.md).
