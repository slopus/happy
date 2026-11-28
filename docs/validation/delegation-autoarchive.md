# Delegated worker automatic archive

Ordinary delegated tasks previously saved their result but retained an idle child
session and executor. A revision required that original worker to remain alive.
The parent now owns the durable task history while each completed, failed or
confirmed-cancelled revision retires its own child.

## Behavior and verification

| Case | Passing behavior | Coverage |
| --- | --- | --- |
| Terminal root | Save the protected result before requesting archive and full executor cleanup | Coordinator, journal, provider regressions |
| Waiting or uncertain delivery | Keep the worker; never infer completion or resubmit input | Coordinator and worker authorization |
| Cancel before a root starts | Retire only after exact queue removal is acknowledged | Real reporter + message queue + API regression |
| Explicit revision | Start a new child with the frozen executor/model and bounded saved instructions/results | Coordinator and runtime integration |
| Old events | Old exit, ACK, report and request replay retain the original version identity | Coordinator regressions |
| Offline archive write | Release resources with bounded cleanup; recheck exit/reconnect/startup/read and repair only a fresh owned, OS-confirmed dead child through one encrypted metadata CAS | Provider, API, runtime and coordinator regressions |
| Exit before retirement ACK | Consume the concrete exit event once after the in-flight request settles | Coordinator regression |
| Tool bridge | Closing its owner's stdin closes the HTTP/stdio transports and exits the dedicated bridge, including first-connection races | Real child-process tests with local MCP stubs |

Retirement acceptance and confirmed archive/exit have separate persistent flags.
A stale metadata version, identity change, unavailable old handler or permission
error leaves cleanup unconfirmed. There is no timer-driven status polling,
unbound kill fallback, task deletion, model fallback or parent-session archive.

Revision context is task data with explicit shortening/omission markers and a
200,000-character limit. The original and newest revisions are retained in this
snapshot. Full task results remain in the parent history. Native tool history is
not restored into the replacement executor.

## Reproduction

From `packages/happy-cli`:

```sh
pnpm build
pnpm exec vitest run src/daemon/delegation src/daemon/delegationRuntime.test.ts src/api/apiMachine.test.ts src/api/apiSession.test.ts src/agent/acp/runAcp.test.ts src/codex/runCodex.startupTrace.test.ts src/delegation src/codex/happyMcpSchemaProfile.test.ts src/codex/happyMcpStdioBridge.schemaProfile.test.ts src/codex/happyMcpStdioBridge.ownerShutdown.test.ts --project unit
node --test scripts/delegation-real-e2e.test.mjs
node scripts/delegation-real-e2e.mjs
```

The real-executor harness remains opt-in (`--run`) and retains its dedicated test
resources as before. It tracks every revision's child, waits for archive events,
and verifies the parent retains prior results. A dry run does not start workers
or access credentials. Automated provider fixtures and bridge subprocesses do
not establish production-machine or user-device acceptance; deployment evidence
must record the actual runtime, result, archived metadata and worker exit.

No page layout or composer UI is added. Screenshots and mobile playback have not
been requested or collected for this runtime change.

Source validation on 2026-11-28: 520 related Vitest cases across 16 files and
8 harness Node cases passed. CLI typecheck/build and independent code review
passed. These are source and local subprocess results; installed runtime and
production acceptance are separate delivery records.
