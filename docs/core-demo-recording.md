# Synchronized core demo startup

The demo consumes the reusable [mobile gym](../packages/happy-mobile-gym/README.md).
There is no demo-specific launcher, active environment pointer, or product UI
fixture. Create a private run and keep its foreground controller alive:

```sh
pnpm mobile-gym create --repository "$PWD" --owner "core recording" --server-port 64950 --metro-port 64951
pnpm mobile-gym start --run /absolute/runRoot/from/create
```

Pass that explicit run root to the desktop recorder's mobile integration. Its
`manifest.json` supplies loopback endpoints and source provenance, with a private
credential-file reference for normal account pairing when needed. Follow the
package README for ownership, readiness, graceful stop, recovery, and the exact
debug-only startup boundary. Existing old demo environments are not migrated or
deleted automatically; choose a fresh gym run. Never publish credential files or
the account-bearing debug JS bundle. Stop the controller after capture.

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