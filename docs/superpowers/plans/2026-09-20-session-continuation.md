# Session Continuation Implementation Plan

**Goal:** Replace unrecoverable provider execution with a fresh session while preserving the readable conversation.
**Architecture:** Account-aware spawn plus encrypted continuation edges; original session-scoped message rendering composed into one transcript. No initial message.
**Tech Stack:** Expo React Native/Web, Zustand, existing encrypted metadata CAS and RPC, Vitest, Ego.
**Spec:** ../specs/2026-09-20-session-continuation.md

## Constraints
- Sibling worktree; no changes to root main, no auth export, no resume/fork dependency.
- Wait for user input; preserve original session and project files.
- Semantic theme tokens; mobile and Web; Ego only for browser verification.

## Review focus
- Spawn success followed by hydration failure must reuse the created ID.
- Unknown RPC outcome must not be auto-retried.
- Session boundaries must prevent mixed tool grouping, ID collisions and wrong attachment routing.
- Old options, approvals and embedded apps must not execute.
- Missing/cyclic ancestry must surface a history gap; paginated history must remain reachable.

## Tasks
- [x] Test fresh-start orchestration and duplicate/failure behavior, then implement in sync/sessionContinuation.ts and connect recovery/menu actions.
- [x] Test read-only interaction scope, then implement shared transcript read-only context.
- [x] Test scoped transcript composition and ancestry handling, then integrate existing transcript rendering/pagination and visible boundaries.
- [ ] Run focused tests, app typecheck and Web build; independent review and fix confirmed findings.
- [ ] Ego actual logged-in acceptance on a failed source: create without sending, read history, send harmless probe, repeat/reload; report screenshots and verified video.
- [ ] Commit/push PR, deliver preview OTA per repository contract. Keep merge separate pending exact merge-message confirmation.

## Validation checkpoint

- Focused regression: 12 suites / 148 tests passed. Independent review: pass, 7 suites / 108 tests passed (overlapping coverage, not additive).
- App typecheck passed after fixing edit callback return type.
- Ego uses existing login against the development build and real server. Successfully created a fresh session, persisted both continuation links, rendered original history and the new-session divider, and confirmed zero messages in the new session.
- Full send/reply acceptance remains pending: the first linked worker exited after the Codex initialize handshake failed to complete within 30 seconds. RPC startup can also exceed the transport deadline; unknown outcomes are retained instead of blindly spawning again.
- PR / preview / video delivery remain pending full E2E and interaction gates.

### Earlier blocked checkpoint (superseded by later verification)
- Post-fix UI suites: 83/83 passed. Startup error-boundary and integration suites: 22/22 passed, including distinguishing transport failure from explicit rejection.
- Ego reload preserved the continuation route and old history. A further fresh-start request timed out before a worker was reported; no further retry was issued because late creation is possible.
- Existing worker log: initialize sent, no initialized acknowledgement, cleanup after 30 seconds. A read-only direct initialize probe against the same binary succeeded, so this is specific to the managed launch path/environment; root cause is not yet proven.
- Shared daemon/account bindings were not restarted or changed. Existing concurrent sessions remain untouched.
- Production Web export was stopped while E2E remained blocked; it is not a passed build. Development Web served the real tested UI.
- Remaining: resolve managed startup latency/initialization, pass real send/reply and repeated-continuation E2E, assess initial divider scroll position, interaction review, final video, production build and PR/preview.

### Retry verification (2026-09-20, around 03:20 CST)
- Existing Ego task and login reused. The earlier timed-out launch had eventually created a live worker; a harmless no-tools prompt received the expected response. This orphan has no automatic continuation edge; it is not counted as successful continuation.
- A new UI continuation from the previously linked (empty/offline) successor successfully created another live session. Both persisted edges were confirmed. The original ancestor history remained readable across the empty intermediate session. New target had zero messages before the explicit test prompt.
- Sent a harmless probe through the new continuation composer; received the exact expected response. Reload preserved both old history and the new exchange.
- Remaining observed issue: the completed reply initially left the composer in running state; after reload it showed completed. Do not describe all acceptance gates as green until this state transition is verified.
- Unknown late-launch automatic recovery, final interaction/video/build/PR gates remain outstanding. No deployment was performed in this retry.

### Current acceptance checkpoint (2026-09-20)
- Fixed stale async metadata writers restoring `thinking`, timestamp ordering of terminal/activity events, and subagent terminal projection incorrectly clearing the parent task. The continuation waiting hint now appears only before new messages exist.
- Final focused regressions: 12 distinct suites / 376 tests passed. App typecheck and diff whitespace checks passed. Independent source review and independent narrow-screen interaction review passed.
- Restarted only this worktree's local Expo preview without CI mode; the earlier CI preview disabled file watching. Verified the browser loaded both new code signatures before counting the final run.
- Real Ego Mobile Web (430 × 932), existing login, real server: explicit harmless prompt received the expected response in 3.64 seconds; navigation time origin unchanged; on-screen status automatically completed, on-screen stop control disappeared, send control returned. No page refresh during the tested turn.
- Original questions, answers, read-only options and old error remained above the new Session boundary. Existing repeated-continuation and zero-message-before-explicit-input observations remain valid.
- Three-page annotated screenshot report visually inspected and delivered to the user through Happy send_image. Local PDF/PNG artifacts: `/Users/jacky/Downloads/paws-session-continuation-acceptance-20260920/`. Private chat screenshots were not added to this repository.
- Remaining scope: late-created sessions after startup timeout are not automatically recovered/linked; native Android/iOS acceptance, production build, video, PR and preview publication have not been completed. No production deployment or merge is claimed.
