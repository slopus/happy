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

Daemon group identity: `sha256(JSON(['claude-setup-token', managedAccountId]))`. This is the server ref identity.
cswap list rows map to it through the synthetic email.

## Capability (`ai-credential:capabilities`, now async, additive)

`cswap token-runtime capabilities` must return `{version:1, artifact:'saycode-setup-token-runtime-v1', managedAccountMetadata:true}`.
Only then does the daemon add `setupTokenVersion:1, setupTokenStatusVersion:1, setupTokenSessionBindingVersion:1` and
`newSessionProfileBinding:true`. Otherwise those fields are absent, and `newSessionProfileBinding` is `false`. Numeric versions are not
evidence. `groupAssignmentVersion` alone is not sufficient. (The server proposed the name `claudeSetupTokenVersion`. Happy uses
`setupTokenVersion`, as the parent requested. Consumers must use one name.)

A managed payload on an unmarked, failing or missing cswap fails with `CLAUDE_SETUP_TOKEN_UNSUPPORTED` (action_required).
The check runs in `groupSync` before the journal snapshot, and in the additive apply before `ensureClaudeSwap`.
Nothing is installed or written. Separately, `ensureClaudeSwap` no longer downgrades an installed build ≥ 0.25.0, and installs
the 0.25.0 pin only when cswap is missing or older.

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

## New-session binding (spawn)

`spawn-happy-session` accepts `aiAuthSelection:{kind:'claude-setup-token', managedAccountId}`. Older daemons reject the unknown
kind, which fails closed. For **new spawns only**, `sessionEnvironment(agent, selection)` checks four things: the marker; that `cswap list` has the
slot enabled; that `cswap export` holds `credentialType:setup_token` with the same ID; and an `sk-ant-oat01-` token. It then returns
`CLAUDE_CODE_OAUTH_TOKEN=<token>`, `HAPPY_AI_AUTH_SOURCE=org-bundle`, and every other `CLAUDE_AUTH_OVERRIDE_ENV_KEYS` set to `''`
(so tmux-server values are overwritten too). Inherited and requested auth overrides are stripped, and `ANTHROPIC_MODEL` is kept.
`verifyAiAuthSelection` then requires `org-bundle` in the final env on both the plain and the tmux path. Any failure →
"Failed to spawn session: CLAUDE_SETUP_TOKEN_BINDING_UNAVAILABLE|UNSUPPORTED". There is no substitute credential. Binding never runs
`cswap switch`, so the machine's active account and running sessions are unchanged.

## Remaining scope / limitations

- **Resume of a bound session is not pinned.** The resume path still calls `resolveManagedAiCredentialEnvironment(resumeAgent)` with
  no selection, so a resumed bound session runs on the machine default. Next step: persist the selection in tracked session
  state and pass it on resume, or refuse resume.
- Untested against a live Claude CLI: that `CLAUDE_CODE_OAUTH_TOKEN` authenticates a setup-token, and that empty-string overrides
  (e.g. `ANTHROPIC_BASE_URL=''`) count as unset. The token is visible to the child's tool subprocesses, as with the Z.AI lease env.
- No real marked cswap artifact was run. A run would write the macOS Keychain, so the fakes mirror provider `transfer.py`/`token_runtime.py`.
- Desktop must send the new selection and gate on `newSessionProfileBinding`. Server/Desktop must agree on the capability name.
- Usage observations / `cswap token-runtime status` adapter, and org collector: not in this change.
