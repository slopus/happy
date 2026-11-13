# Paws model, navigation and conversation-list regressions

Base: `26c17bfdc08fe5b94ad2cc8ccb3ebbe66fc1fb31`.

## User-visible acceptance

| Case | Expected behavior | Result / evidence |
| --- | --- | --- |
| C1 Model → effort | Switching Sol → Terra retains the supported Max effort; reset is explicit | Component regression and real complete App passed |
| C2 All projects → Home | Returns to `/`, with the composer visible | Complete App route assertion + before/after |
| C3 Activity Center | Project sidebar stays opaque and expanded under the dialog | Complete App: sidebar alpha .85 → 1; dialog ancestor opacity verified 1 |
| C4 New session hover | Mouse hover uses the active theme's pressed surface and clears on leave | Component regression + real pointer hover |
| C5 Fast persistence | Model / effort / Fast survive All projects → Home and full reload | Complete App restored Terra / Max / Fast |
| C6 Pinned category | Desktop default and Lists views omit the Pinned category; conversations remain under their normal project/list/recent view | Component regressions and complete App |
| C7 Timeline | Original conversation dates survive today's thread replay, startup-ready, heartbeat, metadata writes and reload | Isolated real encrypted server/socket/CLI-client test: Yesterday and 2 days ago remained distinct |
| C8 Continue old conversation | A confirmed new user message promotes only its conversation; old snapshots do not undo it | Complete App: 2 days ago → Today; yesterday unchanged; ACK-only and delayed-snapshot regressions |

18 App suites: **269 tests passed**. Server route suite: **4 tests passed**.
Rebased onto `c2af5a12` (including the newer mobile-effort fixes) before the final run.
App and server full TypeScript checks passed. Independent code review passed;
independent static screenshot review passed all three requested comparisons.

## Three requested visual comparisons

All images use 1440 × 900 CSS pixels, DPR 1, the same synthetic account and Claude
EVA cream photo skin. Relevant base components were replayed in the same complete
App to capture the defects. Home and hover share one original Before frame.

| Case | Before | After |
| --- | --- | --- |
| C2 Home | [Before](interaction-regressions/home-before.png) | [After](interaction-regressions/home-after.png) |
| C3 Activity Center | [Before](interaction-regressions/modal-before.png) | [After](interaction-regressions/modal-after.png) |
| C4 Hover | [Before](interaction-regressions/hover-before.png) | [After](interaction-regressions/hover-after.png) |

[Verified-state video (17 seconds)](interaction-regressions/verified-states.mp4)

This is a sequence of verified real App states, not a continuous timing recording.
H.264 / yuv420p / 1440×900 / 30 fps; full decode and all-state contact sheet checked;
also delivered through Paws. The modal Before includes discovery loading, while
After is a stable empty state; sidebar alpha was independently read from the DOM.

## Why recency required server support

Presence and metadata writes advance both `activeAt` and the database's
`updatedAt`; neither is a conversation clock. A newly persisted message can also
be old thread history or an executor startup-ready event.

Snapshots now include at most one latest **encrypted** message using the existing
session/sequence index. The client combines its original normalized timestamp
with the root turn's original timestamp, skips service/startup/child-agent events,
and keeps a monotonic verified clock. POST acknowledgements advance confirmed
user messages even without a socket echo. Warm snapshots retain that verified
clock and the latest ciphertext. Unknown empty-shell clocks remain null so older
imported history can replace the displayed creation-date fallback.

No database migration, periodic business query, or external model execution is
required. Web/OTA alone do not update the server API: server deployment is also
required for cold snapshots to obtain their encrypted tail. Legacy records with
no original timestamps, root turn status or meaningful tail fall back to creation;
this change does not reconstruct timestamps that were never stored.

## Reproduce

Use `packages/happy-app/e2e/fixtures/codex-settings/serve.mjs` and its README.
`seed-recency.mjs` adds original yesterday / two-days-ago threads plus today's
startup-ready records. Its loopback controller supports one explicit presence +
metadata write, one explicit user continuation, and cleanup. App, PGlite server,
encryption, sockets and RPC are real; the executor and model catalog are synthetic.
No production account, machine or task is modified.
