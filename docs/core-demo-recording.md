# Synchronized core demo startup

`environments/coreDemo.mts` is a local recording launcher. It is not imported
by `happy-app`, and it is never part of an iOS, Android, web, or desktop app
bundle.

## Startup boundary

Create a private environment, start its loopback server, seed one temporary
account, then start the debug Metro app:

```sh
pnpm tsx environments/coreDemo.mts new
pnpm tsx environments/coreDemo.mts server
pnpm tsx environments/coreDemo.mts seed
pnpm tsx environments/coreDemo.mts metro
```

The launcher binds both services to `127.0.0.1`, gives the server an isolated
data/PGlite directory, and generates a random per-environment master secret in
a mode-0600 ignored file. Environment creation runs its migration with a
sanitized child environment and emits no generic `env.sh` or bin launcher for
this isolated environment. `HAPPY_DEMO_MASTER_SECRET` may override that secret
for a controlled local run, but it is never required in source or printed.

The server child receives an explicit environment allowlist. Host cloud,
GitHub, S3, SSH, and other ambient credentials are not inherited. The auth
token and account secret are stored in a mode-0600 ignored file and passed only
to the debug Metro child as `EXPO_PUBLIC_DEMO_DEV_TOKEN` and
`EXPO_PUBLIC_DEMO_DEV_SECRET`. The app accepts those variables only when both
`__DEV__` and the exact `EXPO_PUBLIC_DEMO_MODE=1` flag are true, rejects
non-loopback server URLs, and clears persisted credentials when demo
credentials are missing. A production bundle cannot use this startup path for
authentication. `EXPO_PUBLIC_DISABLE_ANALYTICS=1`
disables app analytics for this disposable run; `HAPPY_DEMO_MODE=1` identifies
the server run without changing product behavior.

Do not put a demo token, account secret, master secret, local environment data,
or a built debug bundle in Git. Do not use this launcher against a production
server. Stop its children after capture.

## What the synchronized recording proves

The phone is a current-main native app on a dedicated Simulator. The desktop
recorder drives a real local Happy Agent and the phone is paired through the
real encrypted integration. Session history, unread state, edits, diffs,
message delivery, and native keyboard taps are real. The recorder uses normal
accessibility/touch operations; it does not inject mobile sessions, UI state,
RPC responses, or phone screenshots.

The desktop screenplay still controls the editorial inference text/timing and
the explicitly disclosed offline shipping story. Those are recording fixtures,
not evidence of live vendor inference, a real teammate, a real Git push, or a
production deployment. Keep those fixtures in the desktop recording tooling.

The phone recording should be built from current `origin/main`. Do not carry
the former demo branch's avatar fallback, `xHigh` label override, header patch,
or duplicate pending-message implementation into the app. The stable message
identity/pending-status fix already lives in mobile main and should be verified
by re-recording, not reimplemented here.