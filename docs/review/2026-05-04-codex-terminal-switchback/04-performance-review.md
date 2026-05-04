## WARNING Fresh local launch repeatedly scans the full Codex session day directory
**File:** packages/happy-cli/src/codex/codexThreadDiscovery.ts:107
**Issue:** Fresh local launches call `discoverCodexThreadId` every 250ms for up to 10 seconds, and each call recursively lists every `.jsonl` file under the launch date directory before opening candidates one by one. On a machine with a large Codex session history for the day, this turns startup and local handoff into repeated full-tree filesystem scans and many file opens.
**Recommendation:** Make discovery incremental and bounded. For example, list only the expected session date directories once per poll, filter by filename or `stat.mtime` before opening files, remember files already inspected across polls, and stop scanning as soon as the child exits.
**Rationale:** This is production-impacting IO in the default terminal path. Heavy daily session directories can cause slow local startup, disk churn, and avoidable event-loop pressure before the user can interact with Codex.

## WARNING Native launcher keeps polling discovery after Codex exits early
**File:** packages/happy-cli/src/codex/codexLocalLauncher.ts:173
**Issue:** After `Promise.race([discoveryPromise, exitPromise])`, an early successful `exitPromise` still falls through to `Promise.all([discoveryPromise, exitPromise])`. If native Codex exits before a thread id is discovered, Happy keeps polling session discovery until the 10 second timeout, then throws the discovery error instead of promptly returning the child exit code.
**Recommendation:** Distinguish which promise won the race. If the child exits before discovery and no handoff is pending, return the exit result immediately or cancel discovery. If a handoff requires a thread id, bound that special case separately and avoid continuing general discovery after process exit.
**Rationale:** Failed or quickly closed Codex launches should release resources and exit promptly. Continuing discovery after the child is gone adds avoidable filesystem work and can make terminal exits or startup failures appear hung.
