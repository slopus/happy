# Codex subagent history import

## Decision

Do not make the mobile app read `~/.codex`, and do not ask the server to
interpret or join Codex threads.  The supported recovery path is an explicit,
machine-side import that writes already-visible child records back into the
*parent Happy session* as normal encrypted session-protocol envelopes.

This is deliberately an import, not a live cross-session query.  It preserves
the existing E2E boundary and lets every Happy client render imported output
from its ordinary parent-session message history.

## Why the current detail panel is empty for old Codex children

The inspector resolves a child by the generated Happy `sessionSubagent` id and
searches the parent session's nested messages.  It has no source other than
that parent message stream.

Codex keeps independently spawned agents in separate local rollout JSONLs.
Those files contain a provider `thread_spawn.parent_thread_id` relationship
and their visible messages/tool calls.  Older Happy sessions stored only the
parent's activity/lifecycle envelopes; the child rollout was never converted
to child-scoped envelopes and uploaded.  Consequently the title/status is
available, but the inspector has no transcript to render.

The server cannot repair this on its own:

- `SessionMessage` is keyed only by `sessionId`; it has no Codex thread or
  subagent relationship column.
- Its `content` is opaque encrypted data.  The server cannot decrypt it to
  discover a parent thread, inspect a task's `receiverThreadIds`, or create a
  safe child message.
- The mobile app has the decrypted parent messages but must not receive
  arbitrary filesystem access to the machine that ran Codex.

## Required persisted relationship for new work

The live Codex mapper already creates a stable, app-facing `sessionSubagent`
(a CUID) for a provider child thread.  When it emits the parent Agent tool
call it also retains the provider id in `receiverThreadIds`.

Future imports must preserve this relationship in the encrypted parent stream:

| Identifier | Owner | Purpose |
| --- | --- | --- |
| `parentHappySessionId` | Happy | target session to append to |
| `parentCodexThreadId` | parent session metadata | prove which child rollouts belong to the session |
| `providerThreadId` | Codex rollout | locate the child JSONL and its `thread_spawn` parent |
| `sessionSubagent` | parent Agent tool input | existing CUID used by the app inspector |

No provider UUID may be used as `SessionEnvelope.subagent`: the protocol
intentionally accepts a CUID, and changing that would break the reducer's
nesting contract.

## Import RPC contract

The mobile app should expose an explicit retry action only when it can derive
all four identifiers above from the selected parent task.  It calls a daemon
RPC on the original machine:

```ts
type ImportCodexSubagentHistoryRequest = {
  parentHappySessionId: string;
  parentCodexThreadId: string;
  providerThreadId: string;
  sessionSubagent: string; // validated CUID
};

type ImportCodexSubagentHistoryResult =
  | { state: 'imported'; messages: number }
  | { state: 'already-imported'; messages: number }
  | { state: 'unavailable'; reason: 'machine-offline' | 'rollout-missing' | 'parent-mismatch' | 'mapping-missing' }
  | { state: 'failed'; retryable: boolean };
```

The daemon/CLI implementation must:

1. Locate the provider rollout by `providerThreadId`; never scan or return an
   unrelated rollout.
2. Verify its `thread_spawn.parent_thread_id === parentCodexThreadId` before
   reading messages.  A mismatch is `parent-mismatch`, never a best-effort
   import.
3. Convert only user-visible content and tool lifecycle records to existing
   session envelopes scoped by `sessionSubagent`.  Omit reasoning/thinking and
   raw credentials or local configuration values.
4. Append those encrypted envelopes through the parent `ApiSessionClient`, so
   the existing server persistence and client reducer continue to work.
5. Use deterministic message `localId`s such as
   `codex-history:<providerThreadId>:<rollout-item-id>:<kind>`; current random
   local ids would duplicate every retry.  The v3 message endpoint already
   guarantees idempotency for an identical `(sessionId, localId)` pair.
6. Return `already-imported` when every deterministic id already exists.

The parent Agent tool and its lifecycle messages are not recreated.  Imported
records attach to the existing `sessionSubagent`, which keeps the original
title, status, depth, and the inspector's nesting behavior intact.

## Historical eligibility

| Parent data | Child rollout | Result |
| --- | --- | --- |
| parent metadata has `codexThreadId`; parent task has one matching provider id and CUID | matching rollout with matching `parent_thread_id` | importable |
| parent task has no `receiverThreadIds`/CUID mapping | any rollout | `mapping-missing`; do not guess from title/path |
| parent metadata lacks `codexThreadId` | any rollout | `mapping-missing`; no trustworthy parent proof |
| mapping exists but rollout was pruned or is on a different machine | none locally | `rollout-missing` |
| rollout parent id differs | found rollout | `parent-mismatch` |

Thus records created before the provider-id-to-CUID mapping was emitted cannot
be automatically repaired.  Showing an honest unavailable state is safer than
attaching another agent's private output to the wrong session.

## Implementation split

This plan intentionally does not modify the live Codex runner or sidebar
because those are separate ownership areas.

1. **CLI/daemon:** add the RPC handler and a pure JSONL-to-envelope importer;
   inject the known provider-id → `sessionSubagent` mapping rather than
   generating a new CUID.
2. **API session client:** allow a caller-supplied deterministic local id for
   imported envelopes (regular live events may retain random ids).
3. **App inspector:** derive the provider id from the existing parent Agent
   call, offer retry/import states, and refetch the parent message pages after
   `imported`.

No server schema or server-side decryption change is required.  The server
continues storing opaque parent-session messages and enforcing ownership.

## Tests required with implementation

- Importer unit test: a matching `thread_spawn` yields only visible text/tool
  envelopes, all scoped to the supplied CUID; hidden reasoning is absent.
- Importer unit test: a mismatched parent thread produces no envelopes and
  `parent-mismatch`.
- API-session unit test: two import attempts with the same deterministic local
  ids emit one persisted batch logically (the server's existing v3 dedup is
  the durable boundary).
- App test: `mapping-missing` and `rollout-missing` are visible, retry is only
  offered for a complete mapping, and an `imported` response refreshes the
  inspector transcript.
- End-to-end fixture: parent activity plus a separate completed child rollout
  becomes visible in the existing inspector after one import, without exposing
  hidden reasoning.

