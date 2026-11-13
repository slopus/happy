# Codex unified settings acceptance fixture

Start from the repository root:

```sh
pnpm exec tsx --tsconfig packages/happy-cli/tsconfig.json packages/happy-app/e2e/fixtures/codex-settings/serve.mjs
```

This starts the actual App and server with an isolated PGlite account. The machine and session use real encrypted RPC/socket/message transport. The catalog is synthetic, with explicit `priority` support on Sol/Terra, an unsupported Astra option, and 18 clearly labelled long-list samples. The executor is a **stub**: it receives messages and records `model`, `effort`, and `fast`, but does not launch a daemon or call an external model.

Ignored `test-results/codex-settings/runtime.json` contains safe runtime URLs and the initial session ID. `auth-url.txt` is private. Use Ego to load the authentication entry, then navigate explicitly to the clean Web root before any wait that might print a URL or any screenshot. Do not print, copy into reports, or publish authentication parameters.

The loopback controller supports:

- `GET /runtime`: runtime/boundaries.
- `GET /metrics`: whitelisted spawn/message mode records; no message text or credentials.
- `POST /offline`: mark fixture sessions inactive.
- `POST /online`: reactivate fixture sessions once.
- `POST /shutdown`: stop clients/services and remove this fixture environment after responding. Prefer this endpoint when a parent package runner intercepts SIGINT.

Transport pings renew presence; there is no periodic business-state read. SIGINT/SIGTERM stops this fixture's clients/services and removes only its own environment.

Acceptance cases:

1. New session: select Codex, open the unified settings, search/select a model, change effort and Fast, submit one synthetic message, and read the matching three fields from `/metrics`.
2. Existing session: change next-turn settings, drag effort (release commits), use Space for Fast/effort, close with Escape, verify focus restoration, submit one message, and read its fields.
3. Switch from a priority-capable model to Astra: Fast disappears. Switch back: Fast is off.
4. At 900×550, scroll the long model list to its final synthetic option and select it. Keep the popover inside the viewport.
5. Check semantic theme states in a nondefault dark theme. Keep native and non-Codex selectors on their original paths.

Use only Ego for browser execution. Record one numeric task space, exact target, clean expected URL, and a session-bound Happy capture context. Set and assert the viewport in the same Ego round as each screenshot. Separate reviewers should create a separate fixture session; different task spaces still share same-origin local preferences.

The original browser execution recipe and media from the 2026-11-11 run are local evidence, not portable task-space IDs; see `docs/validation/codex-unified-settings.md`.

Recency regression: while this isolated fixture is running, start
`pnpm exec tsx --tsconfig packages/happy-cli/tsconfig.json packages/happy-app/e2e/fixtures/codex-settings/seed-recency.mjs`
from the repository root. It imports two synthetic threads with original timestamps
one and two days ago, then writes startup-ready records today. Its separate
loopback controller exposes `/sessions`, POST `/presence` (heartbeat + metadata),
POST `/continue` (one new user message to the older thread), and POST `/shutdown`.
Verify Yesterday / 2 days ago survive presence, metadata and reload; only explicit
continuation moves the older thread into Today. No daemon or external model runs.

User-driven ordering transport regression (no browser/model/daemon):
`pnpm exec tsx --tsconfig packages/happy-cli/tsconfig.json packages/happy-app/e2e/fixtures/codex-settings/verify-user-order.mjs`.
This creates and removes its own isolated server/account, verifies alternating Agent
output, confirmed user sends, encrypted metadata conflicts, cold hydration and
completion priority. It does not collect screenshots or claim rendered UI acceptance.
