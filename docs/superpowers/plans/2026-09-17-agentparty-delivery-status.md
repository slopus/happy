# AgentParty delivery checkpoint

This records the active delivery, not a completion claim.

## Implementations in progress

- `codex_spawn_contract`: SDK serialization, CLI RPC/control handlers, daemon
  spawn arguments and focused tests. Owns Paws Agent and CLI contract files.
- `debate_scheduler`: room scheduler, persistence, HTTP routes and dedicated
  `group-chat-debate.test.ts`. Owns rooms.ts and HTTP integration.
- `codex_profiles_ui`: Codex profile settings and Agent management UI. Owns
  profiles.ts, GroupChatApp.tsx and profile-specific tests.

Controller must connect the frozen room profile model/effort to spawn after
the room implementation completes, and connect debate controls to the UI after
the profile UI implementation completes. Avoid concurrent edits to those files.

## Verified controller progress

- Commit `59a9daf5` adds configurable Vite base URL and API/image request prefix
  handling. Four API tests pass; the prefix regression was observed failing
  before implementation.
- Root workspace was verified clean, HEAD equal to origin/main.
- No PR exists for feat/agentparty-poc as of this checkpoint.

## Delivery gap requiring implementation

The existing Web workflow publishes happy-app only. AgentParty is an independent
Node service with durable local data and memory-only Paws credentials. A green
happy-app workflow would not prove AgentParty deployment. Production delivery
needs its own service lifecycle, persistent storage, authenticated routing under
the canonical Web origin, a built frontend prefix, and live verification.
Do not substitute the current temporary tunnel for production completion.

Direct batch SSH to the configured production host was denied by its public-key
authentication. The CI workflow has a separate deployment key; this observation
does not prove CI deployment is blocked. Do not print or extract CI secrets.

## Protocol clarification

Codex already consumes model and effort via user-message metadata in
runCodex.ts. The previous assertion that SDK model selection was impossible
was too broad. The approved spawn contract is still useful to select the model
before the first turn; verify the worker argument parser and actual session
configuration rather than merely asserting that flags were appended.

## Remaining verification

Task reviews; frozen profile integration; debate UI; relevant tests/typechecks;
real luna/low alternating conversation, cap and stop; deployment implementation;
PR/CI/merge; live AgentParty and official Web release verification. None of these
is complete merely because the plan/spec is committed.
