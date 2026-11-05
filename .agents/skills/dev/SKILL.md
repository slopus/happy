---
name: dev
description: >
  Local development guide for the Happy monorepo. How to build, install,
  test, and run the CLI, server, native iOS and Android apps locally.
  Use when the user types /dev, asks how to "build", "start dev", "install
  locally", or "run the ___ package".
---

# /dev - Local Development

Happy is a pnpm monorepo. Everything uses pnpm workspaces — do not use `npm` or `yarn` directly.

## First-time setup

```bash
pnpm install                       # installs deps for every package
pnpm --filter happy cli:install    # builds happy-cli + links it as the global `happy` binary
```

`cli:install` replaces whatever `happy` is on your PATH (npm-installed or not) with a symlink to `packages/happy-cli/`. Daemon is restarted as part of the script. Uses `~/.happy/` — same as production.

To undo: `npm unlink -g happy && npm i -g happy@latest`.

## Packages

    packages/happy-cli     # the `happy` CLI and daemon, published to npm
    packages/happy-server  # Node + Prisma server, deployed via TeamCity
    packages/happy-ios     # native Swift/UIKit client
    packages/happy-android # native Kotlin/Compose client
    packages/happy-wire    # shared Zod schemas + wire types

## happy-cli

    packages/happy-cli
    scripts in package.json:
      typecheck      # tsc --noEmit
      build          # rm -rf dist && tsc --noEmit && pkgroll
      test           # build + vitest run
      cli:install    # build + stop daemon + npm link + start daemon
      prepublishOnly # pnpm test (runs build inside test)
      postinstall    # unpacks difft + rg binaries into tools/unpacked/

Work loop:

```bash
pnpm --filter happy cli:install   # rebuild + relink + restart daemon
happy daemon status               # confirm your build is running
happy doctor                      # list all happy processes
tail -f ~/.happy/logs/$(ls -t ~/.happy/logs/ | head -1)
```

Run a single test file quickly:

```bash
pnpm --filter happy exec vitest run src/path/to/file.test.ts
```

Unit-only (fast, ~1 min):

```bash
pnpm --filter happy exec vitest run --project unit
```

Integration tests hit real APIs and are flaky — run on demand, never in the release gate.

### Dev data sandbox (optional)

`happy` reads `HAPPY_HOME_DIR` to override `~/.happy/`. To run two versions side-by-side without touching your prod auth:

```bash
HAPPY_HOME_DIR=~/.happy-dev happy daemon start
HAPPY_HOME_DIR=~/.happy-dev happy auth
```

Point at a local server the same way:

```bash
HAPPY_SERVER_URL=http://localhost:3005 happy daemon start
```

## happy-server

```bash
pnpm --filter happy-server standalone:dev   # localhost:3005, embedded PGlite, no Docker
```

Point the CLI at it with `HAPPY_SERVER_URL=http://localhost:3005`, or set the server URL in the native app.

## Native mobile apps

Use `packages/happy-ios` (Swift/UIKit) and `packages/happy-android`
(Kotlin/Compose). Read each package's AGENTS.md before building or testing.
Agent device builds and tests run on Kirill's Mac Mini over SSH.

Translations are plain JSON in `packages/happy-i18n`; its README
lists the dependency-free JavaScript generators. The Expo app, web export,
Tauri shell, Expo gym and remote JS log receiver are retired.

## Cross-cutting

- **Hoisted deps:** pnpm hoists node_modules to the repo root. `packages/*/node_modules/` is mostly empty. Node's resolution walks up, so imports work transparently.
- **Workspace deps:** `"@slopus/happy-wire": "workspace:*"` resolves to `packages/happy-wire/` — edits are picked up live.
- **`$npm_execpath`:** legacy; happy-cli uses `pnpm` literally. Windows cmd.exe doesn't expand `$VAR`.
- **Build before tests:** tests spawn the built CLI binary (for daemon integration), so `pnpm test` runs `build` first. Do not remove.

## Releasing

Do not publish by hand. Use `/release` — it handles npm publish, git tags, GitHub releases, and the smoke check.

## Troubleshooting

    happy: command not found     → pnpm --filter happy cli:install
    daemon won't start           → happy daemon stop; rm ~/.happy/daemon.state.json.lock; happy daemon start
    wrong `happy` version        → which happy && ls -la $(which happy) — confirms where it resolves to
    tools/unpacked missing       → pnpm install (postinstall re-extracts)
    stale deps after branch swap → pnpm install (pnpm is picky about lockfile drift)

## Rules

- Never use `npm install` or `yarn install` — only pnpm.
- Never add a `dev` / `cli` tsx-based script back to happy-cli. The build step is not optional — daemon spawns the built binary and would desync.
- Never bring back `release-it`. Releases go through `/release`.
- Never introduce `~/.happy-dev` as a default. It exists as an opt-in via `HAPPY_HOME_DIR`, nothing more.
