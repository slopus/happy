# User-driven session ordering

Reproduction base: `42a94991c241d77f794f012d6df566ad077d99bc` (PR777). Final integration base: `439568582b0f29fe1b573d5ab3bd46e4d51a8951`. User confirmed the revised rule after observing two running sessions swap as agents answered.

## Contract

Within each project/list, running and permission-required sessions share one priority band. Rows within a band use the most recent explicit user submission, with deterministic creation/ID ties. Existing deliberate pins apply within their band; a completed pin cannot outrank a running session. Transport presence never defines the band. Completion only exits the execution band; it does not update user recency.

Drafts, opening a session, agent output, tools, terminal events, heartbeats, metadata/title writes and old unmarked history do not advance the user clock. Timeline date buckets retain the independent conversation-activity clock. Rows inside a timeline bucket use the new stable navigation order.

New App/Web sends capture `meta.userSentAt` before async recovery, locks or uploads, inside the encrypted message. Only a matching text ACK or a durable marked user message confirms that clock. It is merged monotonically into the encrypted session metadata and account-scoped warm cache. Metadata CAS failures never requeue an already delivered message; connection/snapshot events can retry dirty metadata. A revision-based writer drains concurrent user sends without timer polling and guards every asynchronous stage against account/session changes.

No Server, CLI runtime or database migration is required. Legacy sessions without a verified clock fall back to creation time; this does not reconstruct historical last-user-send order. Unmarked native terminal input is outside this marker's current coverage and is not inferred from old history.

## Cases and evidence

| Case | Result | Evidence |
| --- | --- | --- |
| Two running agents alternate output without swapping | Pass | Ordering/storage regressions and isolated encrypted HTTP/Socket.IO round trip |
| User sends, draft typing and exact text ACK | Pass | Real Sync writer composition; only the marked text localId confirms recency |
| Running/waiting priority and completion transition | Pass | Comparator/storage tests; isolated real persisted turn-state updates |
| Cold reload after an assistant tail | Pass | Actual App hydration + SessionEncryption with real SecretBox transport and fresh encryption caches |
| Warm reload/stale snapshots/replayed history | Pass | Independent user clock merge and deterministic legacy fallback tests |
| Concurrent metadata edit, late ACK and account switch | Pass | Actual CAS helper guard tests and Sync writer regressions |
| Four rapid user sends, including a fourth during write three | Pass | Deferred writer regression; final clock persists without later traffic |

Final focused run: **160 tests across 12 suites passed**. Full App TypeScript check passed. Independent code review passed; its single coalescing defect was fixed and independently re-reviewed.

The headless acceptance fixture starts an isolated PGlite Server and synthetic account, uses real encrypted HTTP and authenticated Socket.IO, and calls the actual App hydration, SessionEncryption, metadata CAS and sorting modules. Only the platform binding and socket adapter are supplied for Node. It starts no browser, daemon or external model. The service and synthetic environment were removed, and its port was confirmed closed. Runtime credentials and generated bundles are ignored; the report is `packages/happy-app/test-results/user-session-order/verification.json`.

Run from repository root:

```sh
pnpm exec tsx --tsconfig packages/happy-cli/tsconfig.json packages/happy-app/e2e/fixtures/codex-settings/verify-user-order.mjs
```

## Visual scope

The original three screenshot groups were completed for PR777. A new single comparison covering stable parallel output and completion was offered for this follow-up; the user has not replied. No new screenshots were collected, no screenshot environment was started, and no browser or native-device visual acceptance is claimed. This is not a screenshot merge gate under the repository policy.
