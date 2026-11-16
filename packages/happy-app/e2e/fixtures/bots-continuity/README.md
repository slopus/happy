# Bots desktop continuity regression

Run `node e2e/fixtures/bots-continuity/serve.mjs` from `packages/happy-app`, then open `http://127.0.0.1:49839/` using Ego.

This fixture uses the actual React Navigation container, desktop navigator, BotsScreen and Web asset loader. Auth, launch API and the mounted Bots application are synthetic; it does not validate production VNC or backend availability.

1. Open Bots and enter a draft.
2. Switch Home → Bots repeatedly.
3. Remove Bots route → Bots.
4. Verify the same draft and `window.__stats` of `{ launches: 1, mounts: 1, disposals: 0 }`.
5. Reconnect explicitly; verify counters increment and old runtime is disposed.
