# Application service readiness validation

Base: 534f139e (PR698). Companion Advisor commit: c2d389c (local relationship-advisor-service repository).

## Cases

- A blocked Claude auth-status command does not block a Codex claim. Discovery remains single-flight, stale identity is cleared, shutdown prevents publication. Completed checks publish through a serialized queue even while the main tick is waiting for work to complete.
- Probe/turn admission sends a best-effort hint after commit to exactly the owning machine room. Hints contain no credentials or inputs. Claims retain existing current-grant checks, lease fencing and the machine lock. One-second polling remains available for missed hints and older servers.
- Coalesced hints survive claim/wait races. Socket reconnect, disconnect and shutdown remove old listeners.
- Companion Advisor initializes its fixed private connection once, but business requests still reach current server authorization. New-chat catalog preparation creates no conversation, binding or turn and respects source/connection/target boundaries.

## Evidence

Independent review: PASS after fixing strict default-target projection in Advisor and immediate background Claude identity publication.
CLI: 18 distinct tests across sharedServiceWorker (8), workerWake (2), apiMachine (8) passed. CLI atomic build includes typecheck. The last apiMachine-only rerun covers added reconnect cleanup. Fixture process-start wait was increased from 1s to 4s after loaded-machine flakes; the blocked-claim deadline remains 500ms.
Server: probes, turns, machine event routing (3 tests) and actual HTTP transport (14 tests) passed; typecheck passed. Transport includes post-commit work hints and revoked grants while waiting.
Advisor: 194 passed, 2 existing skipped; production asset build passed.

## Browser evidence and limitations

Ego tested an isolated candidate Advisor against the currently deployed PR698 worker. Empty new-chat initialization performed a 4.871s catalog read in the background without creating history. A subsequent catalog read took 43.5ms. One real short turn returned one user input and one assistant “好”; refresh restored both once. Key verified frames were reported to Happy.

That turn took 36.818s to first text / 36.954s to complete (creation HTTP 2.001s; turn POST 0.125s). The worker changes in this PR were NOT active in this run; local builds were also running. This is correctness/preparation evidence, not proof of end-to-end acceleration or a controlled performance comparison.

No visible layout changes. Browser use was chain diagnosis; no UI demonstration video was recorded. Full native-session prewarming is not implemented: it requires its own authorized lease and cleanup protocol, not a synthetic user turn.

After paired activation, measure cold/warm admission, queue, native startup, first native output and propagation separately using the same model/settings. Do not promise a fixed first-token improvement before those measurements. No schema migration or model/authentication settings change is needed. Old daemons ignore the additive event; new daemons retain polling on old servers.
