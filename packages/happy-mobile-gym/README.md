# Happy mobile gym

A private, real local runtime for mobile integration work, manual verification,
screenshots, and synchronized recordings. It starts the existing server and Expo
development client; it does not create sessions, inject UI state, stub RPCs, drive
a device, install an app, or simulate inference. These use cases share one
lifecycle rather than different behavior-changing profiles.

## Commands

From the mobile repository, after `pnpm install --frozen-lockfile`:

```sh
pnpm mobile-gym create --repository "$PWD" --owner "manual integration" --server-port 64950 --metro-port 64951
pnpm mobile-gym start --run /absolute/path/from/create/runRoot
pnpm mobile-gym status --run /absolute/path/from/create/runRoot
```

Use the returned `runRoot` explicitly. There is no current-run pointer. For pure
JSON stdout without pnpm's script banners, invoke the built CLI directly:

```sh
pnpm --filter happy-mobile-gym build
node packages/happy-mobile-gym/dist/cli.js create --repository "$PWD" --owner "desktop capture" --server-port 64950 --metro-port 64951
node packages/happy-mobile-gym/dist/cli.js start --run /absolute/runRoot
```

`create` writes private files only. `start` holds an exclusive controller lock,
checks both explicit ports, applies existing PGlite migrations, starts the server,
authenticates a real account through `/v1/auth`, then starts Metro. It prints a
`ready` event only after the endpoints are available. Another listener is an
error, not permission to reuse or stop it. `status` reads files only: a lock is
not a promise of liveness. macOS and Linux process groups are supported; Windows
is deliberately rejected until its child ownership boundary is implemented.

The CLI stays in the foreground. Each workload has a small supervisor that
reserves its process-group identity even after the workload exits. The controller
requests shutdown over IPC; only the still-live supervisor signals its own
group. No controller signals a stored PID/PGID. Loss of the controller IPC channel
makes the supervisor terminate its own group. Unexpected supervisor loss fails
closed with the run lock retained for inspection.

Ctrl-C/SIGTERM stops owned process groups, including grandchildren, and releases
the lock. Unexpected server/Metro exit
stops its peer and reports failure. Stop retains the database, account, pairing,
logs, and manifest so restarting the same run is deliberate and reproducible.
There is no PID-based external stop command, automatic stale-lock takeover,
recursive deletion, or reset command. Following SIGKILL or a host crash, inspect
the run's private `controller.lock` and actual process ownership before manual
recovery; never kill a process merely because its PID matches an old file.

## Typed lifecycle

```ts
import { runCreate, runStart } from 'happy-mobile-gym';

const manifest = await runCreate({
    repositoryRoot, owner: 'integration capture', serverPort: 64950, metroPort: 64951,
});
const running = await runStart(manifest.runRoot, { signal });
try {
    // Pair a real Agent and use the normal app/device APIs outside this package.
    // running.manifest contains URLs and private file references, never secrets.
} finally {
    await running.stop();
}
```

`runOpen(runRoot)` validates the owner manifest and exact derived paths.
`running.finished` reports `stopped` or `failed`; callers must observe it while
performing their own work. `stop()` is idempotent. Startup cancellation uses the
same owned cleanup and does not publish a partially ready handle.

## Manifest and private resources

Each run is a unique `.context/mobile-gym/run-<UUID>` directory, mode 0700.
Its mode-0600 `manifest.json` is version 1, kind `happy-mobile-gym`, with:

- `runId`, descriptive `owner`, `createdAt`, canonical `runRoot` and `repositoryRoot`;
- `source.commit`, `source.trackedDiffSha256`, and `source.dirty` at creation;
- `server.{port,url}` and `metro.{port,url}`, always loopback;
- `paths.{manifest,credentials,database,serverLog,metroLog,migrationLog}`.

Desktop consumers read this manifest rather than import launcher internals or
discover an environment pointer. `paths.credentials` identifies private
`auth.json`, whose `{token, secret}` format is only for authorized local pairing;
never print its contents or place it in screenshots, reports, or public bundles.
The manifest itself contains no secret values or credential-bearing URLs.

Source provenance describes creation, not an immutable source snapshot. The
diff hash covers tracked changes; `dirty` includes untracked files but the hash
does not include their bytes. A capture claiming a reproducible commit must use
a clean checkout and keep it unchanged while running. An implementation smoke
from a dirty checkout is identified as such, not presented as a clean release.

PGlite and files live under `server/`; children receive run-local `home/` and
`tmp/`. A random master secret and account seed are separate private files.
The seed is saved before authentication so retries create/use the same account.
Authentication refreshes `auth.json` atomically; it never substitutes production
credentials. Logs are private because dependency diagnostics can contain local
paths or other sensitive runtime data. Only selected summary fields go to CLI
stdout; do not publish raw logs without review.

## Security and truth boundary

Children run from an explicit environment allowlist, not an inherited shell:
no ambient S3/cloud/GitHub/SSH credentials, endpoints, `NODE_OPTIONS`, proxies,
host HOME, or shell setup. Expo dotenv loading is disabled. No external master
secret override is accepted. The server binds IPv4 loopback; Metro uses
`--localhost` and the chosen port, with offline mode and analytics disabled.
The app's command-scoped startup is gated by both `__DEV__` and the exact
`EXPO_PUBLIC_HARNESS_MODE=1`. It accepts only the explicit loopback origin,
ignores persisted server overrides in harness mode, rejects missing credentials,
and does not take auth from query parameters. Production does not use this path.

Harness credentials are deliberately passed to Metro using
`EXPO_PUBLIC_HARNESS_DEV_TOKEN` and `EXPO_PUBLIC_HARNESS_DEV_SECRET`: any produced
debug JS bundle is private account-bearing material, not a distributable asset.
The run-local environment is isolation from ambient configuration, not a sandbox
against hostile repository code or other programs running as the same OS user.
Only run trusted app/server/tooling sources. Runtime files stay gitignored.

Fixture content belongs to its calling integration/scenario. For example, a demo
may control scripted inference text; the harness does not make it evidence of a
real vendor response or deployment. A screenshot must identify its run/source
and be captured from the actual app, not a composed recreation of app UI.