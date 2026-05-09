# `happy serve` — bundled self-host mode

## Goal

Ship a zero-network, fully self-hosted Happy in the regular `npm i -g happy` package. One command — `happy daemon start --serve` — brings up the sync server + web app on `localhost`, with persistent settings so the decision survives reboots. No analytics, no external endpoints, no extra installs.

## Audit findings (state of the repo today)

### Analytics / telemetry
- Only one integration: **PostHog in `happy-app`** (`packages/happy-app/sources/track/tracking.ts:4`).
- Already gated: `config.postHogKey ? new PostHog(...) : null`. Absent key → `tracking` is `null`, every `tracking?.capture(...)` no-ops (~30 call sites).
- Key wired via `EXPO_PUBLIC_POSTHOG_API_KEY` in `app.config.js:181`.
- **`happy-cli`, `happy-agent`, `happy-server`: zero analytics** (verified by grep).

### Server URL (already env-configurable)
- CLI / agent: `HAPPY_SERVER_URL` (default `https://api.cluster-fluster.com`) — `happy-cli/src/configuration.ts:32`, `happy-agent/src/config.ts:11`.
- Web app: `EXPO_PUBLIC_HAPPY_SERVER_URL` + MMKV-persisted custom URL, with an in-app Settings → Server screen (`packages/happy-app/sources/app/(app)/server.tsx`).
- Server: `pnpm standalone:dev` already works — PGlite (embedded Postgres), no Docker/Redis. Only needs `HANDY_MASTER_SECRET` + `PORT`. Entry: `packages/happy-server/sources/standalone.ts`.

### Hardcoded `happy.engineering` URLs (cosmetic, ~5 spots)
- `happy-app/sources/components/SettingsView.tsx:396` — privacy link
- `happy-cli/src/ui/doctor.ts:225`, `src/claude/utils/systemPrompt.ts:20-23`, `src/commands/connect.ts:74` — docs / attribution
- `happy-server/sources/app/api/routes/connectRoutes.ts:102,110,135,151,159,163` — GitHub OAuth redirect (needs `PUBLIC_WEBAPP_URL` env var)
- `happy-app/app.config.js:46,77` + iOS/Android manifests — universal link domain (build-time only)

### Optional SaaS (off without keys)
RevenueCat, ElevenLabs, LiveKit — all gated by config keys in `appConfig.ts`. Enterprise build drops all of them.

### Unavoidable external
`auth.openai.com` in `authenticateCodex.ts` — only hit if user uses Codex. Anthropic / OpenAI APIs use user's own keys.

## Published package size (for context)

`happy@1.1.7` on npm: **121 MB packed / 238 MB unpacked, 67 files.**

Breakdown:
- `tools/unpacked/difft` — 113 MB
- `tools/archives/ripgrep-*.tar.gz` (darwin/linux/win32) — 27 MB combined
- `tools/unpacked/rg` + `ripgrep.node` — 13 MB

Adding ~30 MB for self-host assets (webapp + pglite wasm + migrations) is +25% on an already-large package. The `difft` binary is a separate cleanup opportunity — splitting it into per-platform optional deps would free ~70 MB per install and more than offset the new assets.

## Design decisions

### 1. Serving lives in the daemon

The daemon (`happy-cli/src/daemon/run.ts`) is already long-lived, has a control server, lifecycle management, auto-start via launchd/systemd, and state + settings files. Adding the HTTP server is composition, not new infra. If the daemon is stopped, serving stops. If launchd restarts the daemon, serving resumes.

Trade-off: a happy-server crash takes the daemon down. For v1, acceptable — system service manager restarts. For v2, isolate via worker_thread or child_process.

### 2. Persistence: `settings.selfHost` (not daemon state)

Add to the existing `Settings` interface in `packages/happy-cli/src/persistence.ts:37`:

```ts
interface Settings {
  ...existing...
  selfHost?: {
    enabled: boolean;
    port: number;       // default 3005
    host: string;       // default '127.0.0.1'. '0.0.0.0' to allow LAN / mobile
    dataDir?: string;   // default: ~/.happy/serve
  }
}
```

No schema migration — optional field.

Settings = user intent. `daemon.state.json` (`DaemonLocallyPersistedState`) = runtime state. Keep them separate. Add `selfHostUrl?: string` to `DaemonLocallyPersistedState` so `happy serve status` reports what's actually running.

### 3. Dependencies — only one new direct dep

`happy-cli/package.json` adds **only** `@slopus/happy-server: workspace:*`. Its own deps (`@fastify/static`, `@electric-sql/pglite`, Prisma client, Socket.io server, etc.) come in transitively. No duplication.

### 4. Same-origin web app (one port, one build)

The bundled webapp is served by happy-server on the same port as the API. Trick: at serve time, inject into the served `index.html`:

```html
<script>window.__HAPPY_CONFIG__ = { serverUrl: location.origin };</script>
```

Then patch `packages/happy-app/sources/sync/serverConfig.ts:10-14` with one extra fallback:

```ts
export function getServerUrl(): string {
  return serverConfigStorage.getString(SERVER_KEY) ||
         (globalThis as any).__HAPPY_CONFIG__?.serverUrl ||  // NEW
         process.env.EXPO_PUBLIC_HAPPY_SERVER_URL ||
         DEFAULT_SERVER_URL;
}
```

Production `app.happy.engineering` never gets the script injection → behavior unchanged. Self-host injects → web calls its own origin. No CORS, no second build.

### 5. CLI surface

```bash
# Daemon-integrated (recommended, persistent)
happy daemon start --serve          # enable + persist, boot daemon with server
happy daemon start --no-serve       # disable + persist
happy daemon start                  # reads settings.selfHost, serves iff previously enabled

happy serve status                  # enabled? port? URL? daemon pid? bind host?
happy serve on   / happy serve off  # shortcuts: flip settings, signal daemon to restart

# Ad-hoc (foreground, no daemon, no persistence — dev/test)
happy serve --foreground
```

### 6. CLI URL defaults when self-host is on

`packages/happy-cli/src/configuration.ts:32` currently:

```ts
this.serverUrl = process.env.HAPPY_SERVER_URL || 'https://api.cluster-fluster.com'
```

Extend precedence: env var > `settings.selfHost.enabled` ? `http://{host}:{port}` : null > default. So `happy claude` on a machine with self-host enabled auto-targets the local server without requiring `HAPPY_SERVER_URL` to be set in the shell env.

Settings read is async; bootstrap needs a sync read for configuration init (trivial — read file synchronously at construction).

## Implementation sketch

### New files

**`packages/happy-cli/src/commands/serve.ts`** (~80 LOC)
- Subcommands: `status`, `on`, `off`, `--foreground`
- `on` / `off` → `updateSettings(s => ({ ...s, selfHost: {...} }))` then signal daemon via control client to restart
- `status` → reads settings + daemon state, prints both
- `--foreground` → runs happy-server in the current process (no daemon), useful for CI/smoke tests

**`packages/happy-cli/scripts/build-serve-assets.mjs`** (~50 LOC, build-time)
- `pnpm --filter @slopus/happy-app build:web`
- Copy:
  - `packages/happy-app/dist/` → `packages/happy-cli/serve-assets/webapp/`
  - `node_modules/@electric-sql/pglite/dist/pglite.{wasm,data}` → `serve-assets/pglite/`
  - `packages/happy-server/prisma/migrations/` → `serve-assets/migrations/`

**`packages/happy-server/sources/index.ts`** (NEW, ~40 LOC)
Refactor of `standalone.ts`:

```ts
export async function migrate(opts: {
  pgliteDir: string;
  migrationsDir: string;
}): Promise<void>

export async function startServer(opts: {
  port: number;
  host: string;
  pgliteDir: string;
  masterSecret: string;
  staticDir?: string;
  injectHtmlConfig?: Record<string, unknown>;
}): Promise<{ close(): Promise<void>; url: string }>
```

When `staticDir` set, register `@fastify/static` on `/*` with an `onSend` hook rewriting `index.html` to prepend the `__HAPPY_CONFIG__` script tag.

### Modified files

**`packages/happy-cli/package.json`**
- Add dep: `"@slopus/happy-server": "workspace:*"` (only)
- Add to `files`: `"serve-assets"`
- `build` script: run `build-serve-assets.mjs` before `pkgroll`

**`packages/happy-cli/src/index.ts`**
- New subcommand branch for `serve` (~15 LOC)
- New flag parsing for `daemon start --serve` / `--no-serve` (~15 LOC) — writes to settings before invoking `startDaemon()`

**`packages/happy-cli/src/daemon/run.ts`** (inside `startDaemon()`, ~30 LOC)

```ts
const settings = await readSettings()
if (settings.selfHost?.enabled) {
  const { migrate, startServer } = await import('@slopus/happy-server')
  const cfg = resolveSelfHostConfig(settings.selfHost)
  const masterSecret = await ensureMasterSecret(cfg.dataDir)
  await migrate({
    pgliteDir: join(cfg.dataDir, 'db'),
    migrationsDir: findBundledMigrations(),
  })
  const server = await startServer({
    port: cfg.port,
    host: cfg.host,
    pgliteDir: join(cfg.dataDir, 'db'),
    masterSecret,
    staticDir: findBundledWebapp(),
    injectHtmlConfig: { serverUrl: '/' },
  })
  // Register `await server.close()` in the existing daemon shutdown sequence.
  // Also update DaemonLocallyPersistedState with selfHostUrl = server.url.
}
```

`findBundledMigrations()` / `findBundledWebapp()` resolve paths relative to `import.meta.url` → `<pkg>/serve-assets/{migrations,webapp}` — same pattern as `tools/unpacked`.

**`packages/happy-cli/src/persistence.ts`**
- Add `selfHost?` field to `Settings` interface (~5 LOC)
- Add `selfHostUrl?: string` to `DaemonLocallyPersistedState` (~1 LOC)

**`packages/happy-cli/src/configuration.ts`**
- Extend `serverUrl` precedence to consult self-host settings (~3 LOC)

**`packages/happy-server/package.json`**
- Flip `"private": false`
- Rename to `"@slopus/happy-server"`
- Add `"main": "./sources/index.ts"`, `exports` map
- Add `@fastify/static` dep

**`packages/happy-app/sources/sync/serverConfig.ts`**
- 3-line change: add `window.__HAPPY_CONFIG__?.serverUrl` fallback

## Net LOC estimate

| File | LOC |
|---|---|
| `daemon/run.ts` integration | ~30 |
| `commands/serve.ts` | ~80 |
| `persistence.ts` settings extension | ~5 |
| `configuration.ts` URL precedence | ~3 |
| `@slopus/happy-server/index.ts` exports | ~40 |
| Build script | ~50 |
| `serverConfig.ts` webapp fallback | 3 |
| **Total new code** | **~210** |

Bundle impact: **~30 MB added** to npm tarball (~25% on top of current 121 MB).

## Runtime flow (from user perspective)

```
$ npm i -g happy
$ happy daemon start --serve
→ writes settings.selfHost = { enabled: true, port: 3005, host: '127.0.0.1' }
→ daemon forks, reads settings, boots happy-server on 127.0.0.1:3005
→ runs migrations against ~/.happy/serve/db
→ serves webapp + API + socket.io on same origin
→ prints: "Happy running at http://127.0.0.1:3005"

$ happy claude  # now auto-targets http://127.0.0.1:3005
$ open http://127.0.0.1:3005  # webapp talks to its own origin

# On reboot, system launchd/systemd restarts the daemon, which reads settings
# and serves again. Zero additional action required.
```

## Open questions

1. **Master secret lifecycle** — generate-and-persist on first enable to `~/.happy/serve/master-secret` (random 32 bytes). Loud warning if user deletes it → all self-host data becomes unreadable. Or derive deterministically from the user's existing credentials? Current thinking: separate secret, explicit warning.

2. **Bind host default** — `127.0.0.1` (single-user desktop, mobile can't connect) vs `0.0.0.0` (mobile works on LAN, exposes port). Default `127.0.0.1`; document `--host 0.0.0.0`; `happy serve status` explicitly warns on non-loopback binding.

3. **Prisma engines** — verify `pglite-prisma-adapter` actually sidesteps the native query engines (Prisma is notorious for pulling them in at bundle time). If not, may need per-platform optional deps.

4. **Sharp dep in happy-server** — `sharp` has native binaries (~20 MB/platform). Either use npm optional-deps-by-platform (sharp does this itself) or stub out image processing for the minimum self-host path.

5. **Single-user vs multi-tenant** — server is currently multi-tenant. Enterprise self-host probably wants "first client auto-pairs, subsequent clients rejected without explicit admin approval". Out of v1 scope, worth flagging in server config.

6. **OAuth redirects in `connectRoutes.ts`** — hardcoded `https://app.happy.engineering`. Either env-var it (`PUBLIC_WEBAPP_URL`) or disable the GitHub-connect route entirely for self-host.

7. **Cosmetic URLs** — the 5 hardcoded branding links (privacy, docs, attribution). Low priority; either parameterize or live with them.

## Suggested implementation order

1. Export `migrate` / `startServer` from `@slopus/happy-server`, flip `private: false`, add `@fastify/static`. No functional change to anything else yet. Verify the package publishes cleanly.
2. Add `window.__HAPPY_CONFIG__` fallback to `serverConfig.ts`. No behavior change in production.
3. Build-assets script + `serve-assets/` directory. Verify `pkgroll` includes it.
4. `Settings.selfHost` + `happy serve --foreground` command. Runs end-to-end standalone, no daemon integration yet. Smoke test entire flow.
5. Daemon integration (`startDaemon()` reads settings, boots server, closes on shutdown).
6. `happy daemon start --serve / --no-serve` flags, `happy serve on/off/status`.
7. `configuration.ts` URL precedence update.
8. Docs, README, release.

## Related / orthogonal cleanups

- **113 MB `difft` binary** — almost certainly multi-platform blob. Split into per-platform optional deps → ~70 MB saved per install, more than offsets self-host assets.
- **5 cosmetic hardcoded URLs** — parameterize as env vars or settings.
- **OAuth redirect URL** in happy-server connectRoutes — add `PUBLIC_WEBAPP_URL`.
