# Dev Environments

## Real standalone write-scope integration (opt-in)

From the repository root, run `pnpm --filter @buzzni/happy-cli test:integration:write-scope`.
Vitest's normal setup builds the CLI first. Install workspace dependencies and generate the
Happy server Prisma client beforehand using the normal repository setup, including the
repository postinstall patches (an `--ignore-scripts` install must run postinstall explicitly). The test needs
Node 24, `codex` on PATH, the Claude Agent SDK executable (or absolute
`HAPPY_CLAUDE_PATH`), and the existing sandbox dependencies. macOS is supported;
Linux additionally requires working unprivileged bubblewrap namespaces and a disposable
test environment mapping `scope-model.test` to `127.0.0.1` (for example in its `/etc/hosts`).
The fixture validates that this name resolves only to loopback: the sandbox uses a separate
network namespace and bypasses its proxy for literal loopback, so a dedicated hostname
lets the allowlisted model request cross the sandbox proxy without opening network policy. Opting in on an
unsupported sandbox fails the test instead of treating an unprotected launch as success.
Without `HAPPY_SCOPE_SERVER_INTEGRATION=1`, this project skips its native cases.

To accept a registry installation, set `HAPPY_SCOPE_INSTALLED_CLI` to its absolute
`node_modules/@buzzni/happy-cli` directory (install with lifecycle scripts enabled),
and `HAPPY_SCOPE_FRESH_PROVIDER_STATE=1`. The fixture does not create `.claude` in
this mode. Codex still needs a new `.codex/config.toml` to select the owned local model;
no provider conversation or login state is copied. This is fresh conversation-state
acceptance, not provider OAuth onboarding. The source server stays independent of the
installed CLI path. Set `HAPPY_SCOPE_PACKAGED_SERVER` to an absolute compiled server
binary to test packaged-server integration, with its PGlite data/wasm and migrations
beside it. Set `HAPPY_SCOPE_PACKAGED_PRISMA_ENGINE` to its matching native Prisma
query engine library, as Desktop's runtime launcher does. Compile with the output
basename `happy-server`; Bun embeds that name for standalone entrypoint detection.
Record the exact CLI registry integrity and server source identity separately.
Set `HAPPY_SCOPE_ROLLBACK_CLI` to a separately installed `.279` CLI root to opt into
four rollback cases. They require authenticated session/daemon exit before switching
executables while preserving account, provider history, encrypted transcript and scope
journal. Exact `.279` uses its authenticated encrypted legacy machine RPC; the
fixture checks the installed version before that protocol and never falls back from a
failed modern binding. The old runtime must expose no scope capability and resume only the baseline.
All overrides affect the test harness only; they do not activate a Desktop pin.

The [fixture](../packages/happy-cli/src/testing/sessionWriteScopeFixture.ts) owns a source
standalone server with real PGlite migrations, a new account/Happy home and a real daemon.
Native Codex uses an isolated CODEX_HOME and a loopback-only deterministic Responses SSE
endpoint. Native Claude uses a fresh HOME, a local-only fixture API key and a deterministic
Messages SSE endpoint; nonessential Claude traffic is disabled. By default, the disposable
`.codex` and `.claude` state directories exist before wrapping: Linux bubblewrap skips nonexistent
writable roots, which would prevent the provider from persisting its resume history. Claude internal follow-up API
requests can use the same model; they are served locally too. Exactly-once processing is
asserted from stored user replies, rather than equating API request count with user turns.
Fixture TMPDIR is a separate short disposable path so native MCP sockets fit AF_UNIX limits. Child environments are allowlisted; no production server, user credential or
paid model is used. Files are created only in a disposable narrow directory below the OS
account home, which must be writable. Set `HAPPY_SCOPE_FIXTURE_PARENT` to an existing writable
directory below that home if direct home writes are restricted; product root validation still
applies. Test installations are private; no Expo app, production daemon or runtime pin is changed.

The [cases](../packages/happy-cli/src/daemon/sessionWriteScope.integration.test.ts) verify
real host-signed approval, storage/cursor drain, old parent exit, same-ID/thread/encryption
resume and profile receipt. They also cover queued input exactly once, encrypted history,
another session's PID/settings, forged reports, replay, revoke, discarded approval results
reconciled through list, server disconnect and journal recovery across daemon incarnations.
The suite runs both cases for Codex/Claude × legacy/dataKey on macOS (eight cases).
Linux runs the four Codex cases; protected same-UID Claude launches are rejected until
Happy MCP has a transport that works inside that boundary. A separate opt-in native
regression verifies the Linux Unix-socket denial and explicit launch rejection.
In dataKey mode, the fixture opens each session key envelope with its account private key,
checks that two sessions and the machine have distinct keys, and decrypts stored metadata
and transcript using the session key. Recovery opens the machine envelope and uses the
existing encrypted, nonce-bound `resume-happy-session` machine RPC with that machine key.

A disconnected storage drain deliberately retains a blocked runtime. The fault case
explicitly terminates only its owned fixture process group before restarting; that signal
is fault-injection cleanup, **not** a successful drain or proof that all descendants' access
was revoked. Recovered grants stay inactive and the resumed profile uses its saved baseline.
Normal teardown requires clean server/daemon exit and observes session parent exit;
unexpected forced cleanup fails the test. Running the matrix on one platform does not
prove another platform passed; record native OS/provider versions with each result.
Published artifact installation/rollback and Desktop pin acceptance remain separate evidence.

The Codex app-server receives the native `CODEX_SANDBOX=seatbelt` marker only on macOS;
setting it on Linux suppresses its model proxy route despite the external bubblewrap wrapper.
Externally sandboxed Linux launches also strip an inherited `seatbelt` marker from the
child environment without changing the parent's environment.
A protected Claude scope launch is authenticated by its daemon launch channel and stays at
the parent UID. On macOS its mandatory MCP transport uses an owner-only temporary directory
and a token-authenticated Unix socket. Linux same-UID scope launches fail closed with
`MandatorySandboxError`: the protected boundary blocks `socket(AF_UNIX)`, preventing Happy
MCP tools from connecting. The native regression runs with `HAPPY_SCOPE_NATIVE_CLAUDE=1`.
Separate-UID Linux launches retain the existing `agent-sbx` group and `/run/abp-mcp`
requirements. Revisit this rejection only after a transport works inside the same protected
boundary; do not enable all Unix sockets or remove the existing filesystem/network limits.

This document covers the local environment manager in [`environments/environments.ts`](../environments/environments.ts).

## What `pnpm env:*` Does

- `pnpm env:new`: create a new isolated environment under `environments/data/envs/<name>`.
- `pnpm env:use <name>`: switch the current environment.
- `pnpm env:server`: run the server inside the current environment.
- `pnpm env:web`: run the web app inside the current environment.
- `pnpm env:cli`: run the CLI inside the current environment.

Each environment injects its own:

- `HAPPY_HOME_DIR`
- `HAPPY_SERVER_URL`
- `HAPPY_WEBAPP_URL`
- `HAPPY_PROJECT_DIR`
- Expo/server port settings
- dev auth values when seeded

Each fresh environment also gets a copied lightweight fixture project from
`environments/lab-rat-todo-project/` at `environments/data/envs/<name>/project`.

Current limitation: the lab-rat project is copied as plain files only. It does
not include git history yet, so provider tests that depend on realistic repo
history still need a later fixture upgrade.

## `pnpm env:cli` Is A Passthrough

`pnpm env:cli` forwards extra arguments directly to `happy`.

Examples:

```bash
pnpm env:cli --help
pnpm env:cli codex
pnpm env:cli daemon status
pnpm env:cli daemon stop
pnpm env:cli daemon start
```

This is equivalent to sourcing the environment and running the CLI manually:

```bash
source environments/data/envs/<name>/env.sh
happy daemon status
```

## Why `env:cli` Exists

It is a convenience wrapper for the current environment. It does not create or pick an environment on its own. It just:

1. Reads `environments/data/current.json`
2. Builds env vars for that environment
3. Launches the CLI with those vars applied

If you want a lower-level, shell-native workflow, use the generated env file directly:

```bash
source environments/data/envs/<name>/env.sh
happy
```

## Restarting The Current Environment Daemon

Either of these now works:

```bash
pnpm env:cli daemon stop
pnpm env:cli daemon start
```

Or:

```bash
source environments/data/envs/<name>/env.sh
happy daemon stop
happy daemon start
```
