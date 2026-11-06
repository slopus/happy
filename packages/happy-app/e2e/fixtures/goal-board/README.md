# Goal Board full App fixture

Run from the repository root (requires installed workspace dependencies and `ffmpeg`):

```sh
pnpm exec tsx --tsconfig packages/happy-cli/tsconfig.json packages/happy-app/e2e/fixtures/goal-board/serve.mjs
```

The process creates an isolated environment, PGlite database, account, CLI home and Goal First files; starts the actual server and Expo App; then remains alive for Ego acceptance. It never starts or replaces a daemon. `SIGINT` / `SIGTERM` closes CLI clients and removes only its own environment.

The console prints safe ports and session IDs. Runtime/evidence are saved under ignored `packages/happy-app/test-results/goal-board/`:

- `runtime.json`: environment, URLs, bound/unbound session IDs, feature paths and boundaries.
- `auth-url.txt`: private authenticated entry URL, mode 0600. Do not copy its credential-bearing URL into reports.
- `smoke.json`: real encrypted RPC and attachment round-trip checks with timings.

After opening the auth URL through Ego, navigate to `/session/<sessionIds[0]>` for the initially bound board or `<sessionIds[1]>` for initial association. The bound session stays cold for browser artifact acceptance: startup smoke uses another archived session.

## Real paths and explicit stub

The full App, server, account, encryption, `ApiSessionClient`, catalog/parser, `fs.watch`, metadata publishing, text reading, local private attachment request/upload/download, media bytes, image/PDF encryption and decrypt round trips are real. Files have Chinese/space names and descriptive labels; the dataset has 20 canonical/unknown task states plus a second feature, current outputs, references, missing/oversized files, unsupported format and an escaping symlink.

Only `goalBoardStartTask` is overridden on fixture client instances: it idempotently creates a real isolated child session and labels it **STUB**. It never launches a model, daemon or real RSI task. Launcher configuration inheritance and actual daemon behavior remain unit-test evidence, not fixture claims. Stub child sessions receive genuine Goal Board handlers and metadata.

Image/audio/video samples are deterministic ffmpeg fixtures; PDF is a valid deterministic one-page document. These are synthetic test inputs, not real user deliverables. Startup smoke prepares/uploads only the smoke session's media. Browser sessions upload on explicit artifact open only. No new tunnel, public copy, production account or external object bucket is used.

Transport ping events renew session presence. There is no periodic task/file/status read.

## Loopback controller

`runtime.controllerUrl` is bound to 127.0.0.1. Endpoints do not expose account credentials:

| Method | Path | Body / result |
| --- | --- | --- |
| GET | `/runtime` | Safe runtime and boundary data |
| GET | `/metrics` | RPC method/duration records, upload records and stub launches; compare before/after idle/open/close |
| GET | `/snapshot?session=<id>` | One current decrypted session snapshot |
| POST | `/rpc` | `{sessionId?,method,input}`; only four Goal Board methods are allowed, transported through real encrypted server RPC |
| POST | `/mutate` | `{taskCode:"G20",status:"done"}` writes the actual task file; real `fs.watch` publishes metadata |
| POST | `/activate` | One session-presence action |
| POST | `/offline` | Ends the bound CLI client and unregisters its Goal Board handlers |
| POST | `/smoke` | Repeats real original-file and attachment smoke on the bound session (warms it; use after cold measurements) |

To inspect original bytes, use the feature path from `runtime.json`; do not put credentials in shell arguments. To exercise event updates, issue `/mutate` once and observe the real App without pressing refresh. `/metrics` should show no new business RPCs from idle time or closing/reopening a board with a cached snapshot.

The fixture does not claim browser interaction, media playback or PDF-open success: those require separate Ego acceptance in the actual App. It does not authorize screenshots/recording by itself.

## Pressure action (no runtime restart)

Prepare and validate a separate 200-task feature, without changing the active session:

```sh
pnpm exec tsx --tsconfig packages/happy-cli/tsconfig.json packages/happy-app/e2e/fixtures/goal-board/pressure.mjs
```

When ready to measure it in the full App, run the same command with `--bind`. It installs the real Goal watcher via encrypted RPC and updates the bound session's encrypted metadata. This is an explicit fixture action, not an autonomous loop. The feature contains 200 real task records, a 240153-byte Markdown original and a 239640-byte TypeScript original. End markers verify that the viewer retained full content. `pressure.json` records exact sizes and task count. Select the original feature in the App to restore the 20-task board.

## Generated route types

Expo's standalone typed-route scanner does not consume Metro's existing `.test.*` blockList. In this repository it can treat `_layout*.test.tsx` as the root and silently emit empty types. Fixture startup regenerates only ignored `.expo/types/router.d.ts` using the actual `sources/app` root and the same test exclusion as Metro. If needed after a Metro restart, run:

```sh
node packages/happy-app/e2e/fixtures/goal-board/repair-router-types.mjs
```

The helper asserts real session routes before writing; it does not modify product routes or App configuration.
