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
Only then does the daemon add `setupTokenVersion:1` and `setupTokenStatusVersion:1`.
`newSessionProfileBinding:true` and `setupTokenSessionBindingVersion:1` are added only when the marked runtime is present, the daemon has
`HAPPY_APLUS_STUDIO_ORIGIN`, **and** the Studio public key at that origin can be fetched and checked. Otherwise the daemon reports `newSessionProfileBinding:false`.
Numeric versions are not evidence. (The server proposed `claudeSetupTokenVersion`, and Happy uses `setupTokenVersion`. One name must be agreed.)

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

## New-session binding (spawn + resume)

### Selection DTO (`spawn-happy-session.aiAuthSelection`)

`{ kind:'claude-setup-token', managedAccountId:<lowercase uuid>, groupScope:<group-sync scope id>, credentialGeneration:<int ≥1, exact>, bindingGrant:<envelope> }`.
All fields are required. Older daemons reject the kind. The renderer supplies the envelope only. Key, origin, user, company and machine never come from it.

### Binding grant — what Studio must mint (Astra)

Reuse the collector Ed25519 signer key, with its own type and audience:
`bindingGrant = base64url(JSON claims) + "." + base64url(Ed25519(signature over the first part))`, ≤ 4096 chars.
Claims are **exactly** these 13 keys (any extra or missing key is rejected):

| claim | value |
|---|---|
| `v` | `1` |
| `type` | `'claude-setup-token-binding-v1'` |
| `aud` | `'claude-setup-token-binding-v1@' + <Studio public origin>` (this must equal the daemon's `HAPPY_APLUS_STUDIO_ORIGIN` origin) |
| `keyId` | sha256 hex of the SPKI DER of the signing public key |
| `companyId`, `groupScope`, `userId`, `machineId` | `[A-Za-z0-9_-]{1,128}`. `userId` = the Studio `auth.userId` that group-sync used. `groupScope` = the scope string sent in `ai-credential:group-sync`. `machineId` = the **Happy machine id** of the target daemon |
| `managedAccountId` | lowercase UUID |
| `credentialGeneration` | the current generation of that account (positive int) |
| `nonce` | a fresh random UUID per grant |
| `issuedAt`, `expiresAt` | ms epoch; `0 < expiresAt − issuedAt ≤ 300000` |

Before minting, the server should authorize that the caller holds this account through an AI user group assignment in that company, and that the
machine is the caller's. No probe opt-in or budget debit is involved.

Public key: the daemon fetches `GET <origin>/api/claude-collector/public-key` (no redirects, 10 s, ≤ 16 KiB). It requires `version:1`, `algorithm:'Ed25519'`,
and `keyId == sha256(SPKI)`. It ignores the response's collector `type` and `audience` and computes the binding audience itself. The key is cached for 5 minutes and
refetched once when a grant names a different `keyId` (rotation).

### Daemon checks, new spawn (all must pass)

1. Signature, all claims, type, audience, keyId, `machineId == this daemon`, and TTL (60 s skew on `issuedAt`).
2. `managedAccountId/groupScope/credentialGeneration` in the claims equal the selection.
3. The journal entry for `groupScope` is reconciled, lists the account as installed by that scope, and its `userId == claims.userId`.
4. The cswap slot is enabled, holds managed metadata for that ID and a setup-token, and has **exactly** that generation (`…_STALE` otherwise).
5. The nonce is consumed one-use in `~/.happy/setup-token-binding-nonces.json` (durable across restarts; `…_REPLAYED`).

Failures: `CLAUDE_SETUP_TOKEN_BINDING_UNAVAILABLE | _STALE | _REPLAYED | CLAUDE_SETUP_TOKEN_UNSUPPORTED`, surfaced as "Failed to spawn session: …". There is no substitute credential.

### Child env and resume

The child env is `CLAUDE_CODE_OAUTH_TOKEN`, `HAPPY_AI_AUTH_SOURCE=org-bundle`, every other Claude auth override set to `''` (this overwrites tmux-server values),
and the record `HAPPY_AI_AUTH_SETUP_TOKEN_BINDING = {version:1, managedAccountId, credentialGeneration, groupScope, companyId, userId, machineId,
keyId, nonce, issuedAt}`. The record holds the signed facts only, with **no token and no grant**. It is daemon-written: the `HAPPY_AI_AUTH_` prefix is scrubbed
from inherited and requested envs. `verifyAiAuthSelection` requires `org-bundle` in the final env on both the plain and the tmux path.

`captureSaycodeAgentEnvironment` keeps only a valid record. `sessions.json` persists it, and `hydrateTrackedSessionFromPersisted` restores it after a
daemon restart. A resume uses `readSetupTokenResumeSelection(tracked.agentEnvironment)`. It needs no grant, but it re-checks steps 3–4 with the
recorded `userId` and generation. A replaced generation gives `…_STALE`; a revoked assignment, another owner or a removed slot gives `…_UNAVAILABLE`; a corrupt record
refuses the resume. The machine default is never used. Binding never runs `cswap switch`.

## Remaining scope / limitations

- Deployment requirement: the Studio signing key (`CLAUDE_COLLECTOR_SIGNING_KEY` and `APLUS_PUBLIC_BASE_URL`) and the daemon's `HAPPY_APLUS_STUDIO_ORIGIN`
  must name the same public origin. Without them, binding stays unadvertised and refused. Tests use synthetic keys only, and no operating key was changed.
- Astra's mint route and the Desktop selection sender are not in this change. The claim table above is the contract they must match.
- Not checked against a real Claude CLI: that `CLAUDE_CODE_OAUTH_TOKEN` authenticates a setup-token, and that empty-string overrides
  (e.g. `ANTHROPIC_BASE_URL=''`) count as unset. The token is visible to the child's tool subprocesses (same as the Z.AI lease). `cswap run` profile
  isolation is a separate, unproven mechanism and is not used.
- The nonce ledger keeps at most 4096 unexpired nonces. When it is full, binding is refused until entries expire.
- No real marked cswap artifact was run (it would touch the macOS Keychain). The fakes mirror provider `transfer.py`/`token_runtime.py`.
- Happy makes no probe transport, consent, collect or org-collector calls. The status adapter only reads `token-runtime status`.
