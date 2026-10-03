# Claude setup-token runtime — Happy contract result (v1)

Sources: Desktop `specs/claude-setup-token-usage-rotation/contract.md`, Studio server
`specs/claude-setup-token-implementation/contract-result.md`, and cswap provider `specs/token-runtime-contract.md`
(marker `saycode-setup-token-runtime-v1`). Base `origin/main` 33c688bb9 (.284).
Status 2026-10-04: implemented locally and verified with a fake-subprocess harness only. No live token, inference, daemon change or publish.

## Accepted payload (`ai-credential:group-sync`, and merge `ai-credential:apply`)

This is the server vault row, unchanged: `email:"managed-<managedAccountId>@setup-token.local"`, `kind:"oauth"`,
`credentialType:"setup_token"`, `managedAccountId`, `displayName` (1..120), `credentialGeneration` (≥1), and
`credentials.claudeAiOauth.accessToken` (`sk-ant-oat01-`, other fields such as `scopes` allowed). An org UUID or a
`refreshToken` is rejected as `INVALID_PAYLOAD`. Rows without `credentialType:"setup_token"` take the old OAuth/API path unchanged.

Daemon slot identity: `sha256(JSON(['claude-setup-token', managedAccountId]))`. This is **local**, and it is not the server ref
identity (the server also binds companyId). The two are separate authorities. Local scope safety comes from the group journal,
whose ownership and revocation are kept per `(scope, provider)` entry. Another scope can neither replace (`AI_GROUP_CREDENTIAL_CONFLICT`)
nor revoke a slot it did not install, even for the same managed ID (tested).

## Capability (`ai-credential:capabilities`, now async, additive)

`cswap token-runtime capabilities` must return `{version:1, artifact:'saycode-setup-token-runtime-v1', managedAccountMetadata:true}`.
Only then does the daemon add `setupTokenVersion:1` and `setupTokenStatusVersion:1`. `newSessionProfileBinding` is **always `false`** for now, and
`setupTokenSessionBindingVersion` is not advertised (see the binding section). Numeric versions are not evidence. (The server proposed
`claudeSetupTokenVersion`, and Happy uses `setupTokenVersion`. One name must be agreed.)

On an unmarked, failing or missing cswap, a managed payload fails with `CLAUDE_SETUP_TOKEN_UNSUPPORTED` before the journal snapshot and before
`ensureClaudeSwap`. Nothing is installed or written. `ensureClaudeSwap` never downgrades an installed build ≥ 0.25.0.

## Apply semantics

- No inference on merge. Managed rows skip the OAuth duplicate/repair path (`claude --print`).
- New managed row: normal import. Existing slot (same synthetic email): compare against `cswap export -`. If the stored
  `credentialType/managedAccountId/credentialGeneration/displayName/sha256(token)` all match, nothing happens.
  If anything differs:
  - ownership must be proven, either by the group journal's `owned` for this scope (now passed to `apply` as a 3rd arg) or by
    the deploy path's `knownCompanyIdentities`. Without that proof, or if the stored managed ID differs → `AI_GROUP_CREDENTIAL_CONFLICT`.
    This covers a personally imported slot carrying the same synthetic email; it is never taken over silently.
  - stored generation > incoming → `AI_GROUP_GENERATION_STALE`; equal generation with different content → `AI_GROUP_GENERATION_CONFLICT`.
  - otherwise `cswap import --force` with only those rows (this covers rename-only changes too). A lost `disabled` flag is restored with `cswap disable N`.
- Receipt gate: after import, every managed row must match the export on all five fields. Otherwise
  `CLAUDE_APPLY_VERIFICATION_FAILED`, and the group receipt stays `reconciled:false`. Provider storage is authoritative. Happy keeps no ledger.
- Personal slots and the personal active account are preserved. With nothing active, a stored managed slot may be activated
  without `usageStatus:'ok'`. Revoke is the existing scoped journal removal.

## Status DTO (`ai-credential:status` claude, additive)

`setupToken:{version:1, accounts:[{managedAccountId, active, disabled, authState:'unverified',
usageState:'fresh'|'unavailable', usageReason}]}`. It is present only when managed slots exist, and it is secret-free. Managed slots are excluded from
`reloginRequiredAccountCount`. An active managed slot reports `activeAccountStatus:'unknown'`. Probe observations
(`cswap token-runtime status`) are not merged here yet.

## New-session binding (spawn + resume) — implemented, NOT advertised

Selection DTO (`spawn-happy-session.aiAuthSelection`):
`{ kind:'claude-setup-token', managedAccountId:<lowercase uuid>, groupScope:<the group-sync scope, i.e. the company scope string>, credentialGeneration?:<int ≥1> }`.
Older daemons reject the kind. Ownership is checked against the daemon journal, not the renderer. The `groupScope` entry must exist, be
reconciled, list `sha256(['claude-setup-token', id])` in `desired`, and have `userId` equal to the caller. Personal, other-company,
other-user, pending and revoked slots fail. The caller is the `userId` from the consumed MCP caller grant (`mcpCallerGrantCaller`), never from
the selection. No grant → fail. The slot must also be enabled in `cswap list`, and `cswap export` must hold `credentialType:setup_token`, the same ID,
an integer generation and an `sk-ant-oat01-` token. If `credentialGeneration` is given, it must match exactly (`CLAUDE_SETUP_TOKEN_BINDING_STALE`).

The child env is `CLAUDE_CODE_OAUTH_TOKEN`, `HAPPY_AI_AUTH_SOURCE=org-bundle`, every other Claude auth override set to `''`
(which also overwrites tmux-server values), and the secret-free record
`HAPPY_AI_AUTH_SETUP_TOKEN_BINDING={version:1, managedAccountId, credentialGeneration, groupScope, userId}`. That record uses the `HAPPY_AI_AUTH_`
prefix, so it is scrubbed from inherited and requested envs and is daemon-written only. Inherited and requested auth overrides are stripped, and the model
choice is kept. `verifyAiAuthSelection` requires `org-bundle` in the final env on both the plain and the tmux path.

Resume and restart: `captureSaycodeAgentEnvironment` keeps the validated record in the tracked session's `agentEnvironment`, which
`sessions.json` persists and `hydrateTrackedSessionFromPersisted` restores. Resume calls
`readSetupTokenResumeSelection(tracked.agentEnvironment)`: the recorded ID, generation and scope, with the recorded `userId` as caller. That is re-checked
against the journal and storage. A replaced generation → `CLAUDE_SETUP_TOKEN_BINDING_STALE`; revoked or removed → `…_UNAVAILABLE`; a corrupt
record → resume refused. Never the machine default. A session without a record resumes as before. Binding never runs `cswap switch`.

## Remaining scope / limitations

- **Why binding is not advertised:** the caller `userId` comes from the MCP grant envelope. The daemon checks that it is encrypted to this machine,
  bound to the project, not expired and not replayed, but only the server verifies its HMAC. Flipping `newSessionProfileBinding` needs a decision: accept
  that claim (Desktop already mints grants per caller), or have the server add a daemon-verifiable caller/company proof. It also needs Desktop to send the
  selection.
- Journal `userId` vs grant `userId` are assumed to be the same Studio user ID. This must be confirmed with the Desktop group-sync writer.
- Not checked against a real Claude CLI: that `CLAUDE_CODE_OAUTH_TOKEN` authenticates a setup-token, and that empty-string overrides
  (e.g. `ANTHROPIC_BASE_URL=''`) count as unset. The token is visible to the child's tool subprocesses (same as the Z.AI lease). `cswap run` profile
  isolation is a separate, unproven mechanism and is not used.
- No real marked cswap artifact was run (it would touch the macOS Keychain). The fakes mirror provider `transfer.py`/`token_runtime.py`.
- No probe transport, consent, collect or org-collector calls are made by Happy. The status adapter only reads `token-runtime status`.
