# Dev Environments

This document covers the local environment manager in [`scripts/environments.ts`](../scripts/environments.ts).

## What `yarn env:*` Does

- `yarn env:new`: create a new isolated environment under `.environments/<name>`.
- `yarn env:use <name>`: switch the current environment.
- `yarn env:server`: run the server inside the current environment.
- `yarn env:web`: run the web app inside the current environment.
- `yarn env:cli`: run the CLI inside the current environment.

Each environment injects its own:

- `HAPPY_HOME_DIR`
- `HAPPY_SERVER_URL`
- `HAPPY_WEBAPP_URL`
- Expo/server port settings
- dev auth values when seeded

## `yarn env:cli` Is A Passthrough

`yarn env:cli` forwards extra arguments directly to `happy`.

Examples:

```bash
yarn env:cli --help
yarn env:cli codex
yarn env:cli daemon status
yarn env:cli daemon stop
yarn env:cli daemon start
```

This is equivalent to sourcing the environment and running the CLI manually:

```bash
source .environments/<name>/env.sh
happy daemon status
```

## Why `env:cli` Exists

It is a convenience wrapper for the current environment. It does not create or pick an environment on its own. It just:

1. Reads `.environments/current.json`
2. Builds env vars for that environment
3. Launches the CLI with those vars applied

If you want a lower-level, shell-native workflow, use the generated env file directly:

```bash
source .environments/<name>/env.sh
happy
```

## Restarting The Current Environment Daemon

Either of these now works:

```bash
yarn env:cli daemon stop
yarn env:cli daemon start
```

Or:

```bash
source .environments/<name>/env.sh
happy daemon stop
happy daemon start
```
