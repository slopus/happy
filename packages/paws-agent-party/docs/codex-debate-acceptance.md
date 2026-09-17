# Bounded Codex debate acceptance — 2026-09-18

Scope: the normal built AgentParty service, real Paws SDK, the explicitly
authorized Linux test executor, two Codex profiles, and no injected model fixture.

| Case | Evidence |
| --- | --- |
| Max 10 rounds | Two sessions produced exactly 20 completed public replies in alternating order, 10 each. No 21st reply after completion. |
| Model and effort | Both frozen room profiles and all 20 durable user-message metadata records contain `gpt-5.6-luna` / `low`. Both remote sessions also report these values as `currentModelCode` / `currentThoughtLevelCode`; provider-internal routing is not independently attested. |
| Execution provenance | Each completed turn has session, root-turn, durable turn-end and public-message IDs. |
| Manual stop | A second debate was stopped while a member was running. Status became stopped and no subsequent turn was scheduled during the observation window. Remote execution is not claimed terminated. |
| Authentication | The test account was restored through the real recovery endpoint. Account secrets were not written into the report or application storage. |
| Regression | Full Party suite after review fixes: 96 tests passed. SDK spawn serialization: 29 tests; CLI forwarding suites and typechecks passed. Prefixed standalone build/smoke passed. |
| Browser interactions | Real saved history restored; effort changes survived dialog reopening; auto-debate off and a two-round cap survived reload. The final UI shows neutral stopped state and opening/rebuttal round labels. |
| Browser real submission | A separate one-round message was sent through the real composer. Running progress, disabled cap and stop button were visible; exactly two replies completed the configured round. |

Private test artifacts remain outside source control in the task's ignored
`debate-live-20260918` workspace. They contain session provenance, not account
credentials. Browser and production release verification are separate gates;
this report alone does not mean the release is live.
