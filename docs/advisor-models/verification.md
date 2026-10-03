# Advisor engine/model selection acceptance

Base: Paws `221ea84f` (including scoped history); companion advisor repository `fddd8af`.
Companion implementation: `../relationship-advisor--models`, commit `2758f9d` (standalone service, no Git remote configured). Reproducible source delta: [advisor-ui.patch](advisor-ui.patch); apply to advisor `fddd8af`, then rebuild its SDK from this Paws checkout. The patch was verified with `git apply --check`.

| Case | Pass criterion | Evidence / result |
| --- | --- | --- |
| C1 Composer | Compact input, persistent engine/model label, coherent connection state | Ego 1440×960 desktop: composer 101px; independent static reviewer pass |
| C2 Selection | Switch Codex/Claude and preserve context; disable changes while sending | Ego with isolated encrypted SDK fixture: two rounds, correct per-message labels, both controls locked |
| C3 Restore/retry | Refresh restores model; stop retains input and retry selection | SDK binding tests + Ego refresh/cancel/retry |
| C4 Consent | Legacy connection remains Codex-only, upgrading retains access to old history | Server worker fencing tests; SDK rejects Claude before network; Ego old/new connection switch |
| C5 Narrow layout | Menu and input fit 390px viewport | Ego: document width 390; menu x=28..332 |
| C6 Runtime | Requested model is passed to restricted CLI | Real Codex `gpt-6-luna` reports actual `gpt-6-luna`, returns “你好”; Claude subprocess fixtures cover args/images/tool denial/cancel |

## Verification boundary

- UI browser responses are explicitly labeled simulated. They prove interaction and encrypted SDK transport, not live delegated execution.
- Real Codex adapter smoke used the existing advisor auth home, an empty temporary cwd, and `gpt-6-luna`.
- Default Claude Code 2.1.251 is installed; `claude auth status --json` reports `loggedIn:false`. Real restricted Claude smoke fails with `claude-login-or-runtime-failed`. A configured login/API is required before live Claude acceptance.
- Video: 12.65s, 1440×960 H.264, full decode verified; sent to Happy. Independent code and PC static review passed.

- No production database, daemon, advisor release, Paws Web, or OTA was changed. Protocol 3 requires coordinated server migration, Paws client/daemon update, and rebuilt advisor SDK.
- Old grant credentials remain in tab-scoped sessionStorage when upgrading. The connection manager can switch back. Closing the tab/forgetting/logging out removes access as in the existing storage policy.
- Models are an allowlist; account entitlements can still reject a model. There is no automatic engine/model fallback.

## Checks

- Advisor `npm test`: 8 pass.
- Server delegation/routes: 18 pass (real ephemeral PGlite, including old-worker fencing).
- Browser SDK delegation: 24 pass (cryptographic binding, legacy authority, model mismatch).
- Shared model catalog: 6 pass.
- Paws authorization API and OTA contract: 10 pass; scoped history binding: 10 pass.
- Restricted Claude and existing proxy environment suite: 12 pass.
- CLI build and typecheck; server, SDK and App typechecks.

## Minimal rerun

From Paws worktree:

```sh
pnpm --filter happy-server-self-host exec vitest run sources/app/appDelegation/appDelegation.spec.ts sources/app/api/routes/appDelegationRoutes.spec.ts
pnpm --filter @wangjs-jacky/paws-agent exec vitest run src/delegation/browserDelegation.test.ts
pnpm --filter @slopus/happy-wire exec vitest run src/appChat.test.ts
pnpm --filter @wangjs-jacky/paws exec vitest run --project unit src/daemon/appDelegation/restrictedClaude.test.ts src/claude/sdk/claudeProcessEnv.test.ts
```

Browser automation uses Ego only. Paws main worktree remains clean and unchanged.

Latest integration browser check: ordinary chat loads via chat.js, a protocol 3 Claude/Opus conversation opens through the independent read-only history route, URL fragment is removed, composer is hidden and normal connection credentials are preserved. Final screenshot: [readonly-history.png](readonly-history.png). This uses disposable encrypted fixture data.

Screenshots: [model menu](model-menu.png), [per-message model history](model-history.png). Desktop layout was unchanged by the history integration.
