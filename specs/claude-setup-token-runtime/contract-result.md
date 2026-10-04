# Claude setup-token runtime — Happy contract result (v1)

Sources: Desktop `specs/claude-setup-token-usage-rotation/contract.md`, Studio server
`specs/claude-setup-token-implementation/contract-result.md`, and cswap provider `specs/token-runtime-contract.md`
(marker `saycode-setup-token-runtime-v1`). Base `origin/main` 33c688bb9 (.284).
Status 2026-10-04: implemented locally; fake-subprocess boundary tests and an isolated installed-wheel fake-HTTP roundtrip verified. No live token, inference, daemon change or publish.

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
Numeric versions are not evidence. The name `setupTokenVersion` is confirmed across Studio, Desktop and Happy.

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
| `issuedAt`, `expiresAt` | ms epoch; `0 < expiresAt − issuedAt ≤ 60000` (the Studio signer issues 60 s) |

Before minting, the server should authorize that the caller holds this account through an AI user group assignment in that company, and that the
machine is the caller's. No probe opt-in or budget debit is involved.

Public key: the daemon fetches `GET <origin>/api/claude-collector/public-key` (no redirects, 10 s, body read as a stream and cancelled past 16 KiB; malformed or >4096-char envelopes are rejected before any parse or fetch). It requires `version:1`, `algorithm:'Ed25519'`,
and `keyId == sha256(SPKI)`. It ignores the response's collector `type` and `audience` and computes the binding audience itself. The key is cached for 5 minutes and
refetched once when a grant names a different `keyId` (rotation).

Trusted origin: only the daemon's `HAPPY_APLUS_STUDIO_ORIGIN` (the same single source as the org collector). It is never derived from
another URL and never comes from renderer input.

### Daemon checks, new spawn (all must pass)

1. Signature, all claims, type, audience, keyId, `machineId == this daemon`, and TTL (60 s skew on `issuedAt`).
2. `managedAccountId/groupScope/credentialGeneration` in the claims equal the selection.
3. The journal entry for `groupScope` is reconciled, lists the account as installed by that scope, and its `userId == claims.userId`.
4. The cswap slot is enabled, holds managed metadata for that ID and a setup-token, and has **exactly** that generation (`…_STALE` otherwise).
5. The nonce is consumed one-use in `~/.happy/setup-token-binding-nonces.json` (durable across restarts; `…_REPLAYED`).

A fresh grant is re-checked against its `expiresAt` on the daemon clock right before the nonce is consumed and again after the durable
write. Expiry in either place gives `CLAUDE_SETUP_TOKEN_BINDING_EXPIRED` and no token env (after the write the nonce stays burned). A resume
from a record has no fresh grant and no lifetime check.

Failures: `CLAUDE_SETUP_TOKEN_BINDING_UNAVAILABLE | _STALE | _REPLAYED | _EXPIRED | CLAUDE_SETUP_TOKEN_UNSUPPORTED`, surfaced as "Failed to spawn session: …". There is no substitute credential.

### Child env and resume

The child env is `CLAUDE_CODE_OAUTH_TOKEN`, `HAPPY_AI_AUTH_SOURCE=org-bundle`, every other Claude auth override set to `''` (this overwrites tmux-server values),
and the record `HAPPY_AI_AUTH_SETUP_TOKEN_BINDING = {version:1, managedAccountId, credentialGeneration, groupScope, companyId, userId, machineId,
keyId, nonce, issuedAt}`. The record holds the signed facts only, with **no token and no grant**. It is daemon-written: the `HAPPY_AI_AUTH_` prefix is scrubbed
from inherited and requested envs. `verifyAiAuthSelection` requires `org-bundle` in the final env on both the plain and the tmux path.

`captureSaycodeAgentEnvironment` keeps only a valid record. `sessions.json` persists it, and `hydrateTrackedSessionFromPersisted` restores it after a
daemon restart. A resume uses `readSetupTokenResumeSelection(tracked.agentEnvironment)`. It needs no grant, but it re-checks steps 3–4 with the
recorded `userId` and generation. A replaced generation gives `…_STALE`; a revoked assignment, another owner or a removed slot gives `…_UNAVAILABLE`; a corrupt record
refuses the resume. The machine default is never used. Binding never runs `cswap switch`.

## Unbound launches and resumes (spawn-path audit)

Every daemon Claude launch goes through `spawnSession`, which resolves the managed environment at one site. That includes Desktop RPC
`spawn-happy-session`, the `happy agent` facade, automation and Chat(beta) runs, and forks with `parentSessionId`/`resumeClaudeSessionId`.
Every resume goes through `resumeSession`, which resolves at one site, including attention and automation resumes after a restart.
Both sites call `sessionEnvironment`:

| path | behaviour |
|---|---|
| new launch with a `claude-setup-token` selection | signed grant verified, consumed and bound (above) |
| true resume with a recorded binding | rebinds from the record and re-checks journal, owner and generation; corrupt → refused |
| new launch or resume with no binding, while any current group assignment **desires an org-managed setup-token** | **refused**: `CLAUDE_SETUP_TOKEN_SELECTION_REQUIRED`, even with a personal login active. This applies to forks/children too, since `parentSessionId` is lineage only and each child needs a fresh grant |
| same, but no managed setup-token is desired (no assignment, revoked/empty assignment, ordinary OAuth group) | unchanged (machine default) |
| Z.AI lease active | unchanged (lease env) |
| non-Claude agents | unchanged |
| explicit `machine-personal` selection | deliberate escape: managed resolution is skipped (`honorsManagedAiCredentials` false), so the unbound-default guard does not apply; the spawn is still held to the existing applied-source proof |

The decision uses the group journal alone. Each entry now records `managed`, the desired identities that are setup-tokens, projected from
the payload at sync. There is no cswap call per launch. Journals written before this field existed (no `managed` key) are resolved at the next unbound Claude launch or resume:
- An empty (revoked) entry is recorded as `managed: []` without reading the roster.
- A non-empty entry is classified from the `cswap` roster and the live login once. Identities of managed slots count in both formats a
  journal may hold: `sha256(['claude-setup-token', id])` and the older `sha256(['claude', email, ''])`. Every other installed account
  classifies its identity as not managed. This does not depend on which login is active.
- If every desired identity is classified, the managed subset is recorded and the launch is decided on it (refused if non-empty).
- If the roster cannot be read, or any desired identity cannot be classified (for example a pending assignment not installed yet), the launch
  is refused with `CLAUDE_SETUP_TOKEN_ASSIGNMENT_UNRESOLVED` and the entry stays unrecorded, so it is retried later. It is never marked unmanaged.
Ordinary OAuth groups whose accounts are installed are classified and stay allowed.
Not covered: a `happy` CLI started by hand in a terminal, which is outside the daemon.

## Remaining scope / limitations

- Deployment requirement: the Studio signing key (`CLAUDE_COLLECTOR_SIGNING_KEY` and `APLUS_PUBLIC_BASE_URL`) and the daemon's `HAPPY_APLUS_STUDIO_ORIGIN`
  must name the same public origin. Without them, binding stays unadvertised and refused. Tests use synthetic keys only, and no operating key was changed.
- Astra's mint route and the Desktop selection sender are not in this change. The claim table above is the contract they must match.
- Not checked against a real Claude CLI: that `CLAUDE_CODE_OAUTH_TOKEN` authenticates a setup-token, and that empty-string overrides
  (e.g. `ANTHROPIC_BASE_URL=''`) count as unset. The token is visible to the child's tool subprocesses (same as the Z.AI lease). `cswap run` profile
  isolation is a separate, unproven mechanism and is not used.
- The nonce ledger keeps at most 4096 unexpired nonces. When it is full, binding is refused until entries expire.
- The real marked artifact is exercised offline (file backend, isolated home, intercepted network) by the opt-in `aiCredentialSetupToken.artifact.test.ts`; no live provider call.
- Probe transport, consent and collect run only through the Sol RPCs below (personal manual probe, signed org collector); status reads `token-runtime status` through Sol's strict `readTokenRuntime`.
- Automatic rotation is disabled pending every writer's ownership/lease/CAS.
- No live provider/model/header/authentication fixture or deployed artifact was verified.
- Desktop owns organization scheduler/discovery/reserve/publish and receiver observations.
  Its integration and Studio's actual HTTP auth gate are parent-owned checks.
- Resident scheduling is default OFF and gated by durable personal consent and daemon Claude activity.

## Happy organization collector bridge v1

Customer-key, freshly nonce-bound RPC only: `ai-credential:collector-probe`.
Request exact fields:
```ts
{version:1, companyId:string, userId:string, machineId:string,
 managedAccountId:string, accountRef:string, credentialGeneration:number,
 policyRevision:number, permitId:string, grant:string}
```
`grant` is Studio's signed reserve envelope, never the plain reserve DTO. No caller
origin/key/bearer accepted. Studio origin is daemon `HAPPY_APLUS_STUDIO_ORIGIN`
origin. GET `/api/claude-collector/public-key` uses no Studio bearer and refuses
redirects, unsafe non-loopback HTTP, unknown algorithms and mismatched key hash.
Claims match every scope/request field including permitId. Request accountRef must match
the unique current managed provider roster row and generation. Local reconciled group journal must
independently match company/user and contain the managed identity. Journal group
revision is not the per-account credentialGeneration.

Success `{version:1,status:'observed',companyId,machineId,managedAccountId,credentialGeneration,policyRevision,permitId,observation}`; observation is only
`{source:'inference_probe',observedAt:number,windows:[{kind,pct,resetsAt}],
coverage:'unknown',reason,retryAt:number|null}`. All times epoch milliseconds.
Reasons: ok/headers-missing/rate-limited/authentication-failed/scope-missing/
request-failed/timeout. No credentials, account roster, authState, binding receipt
or active selection. Desktop publishes with its existing authenticated identity.

Failure `{version:1,status:'action-required'|'unavailable',error:'COLLECTOR_...'}`.
Missing configuration/key is action-required SIGNER_UNAVAILABLE; invalid claims
GRANT_INVALID; expired PERMIT_EXPIRED; replay PERMIT_REPLAYED; local journal
mismatch ACCOUNT_NOT_ASSIGNED; roster mismatch GENERATION_CHANGED; unsupported
artifact RUNTIME_UNSUPPORTED; transport/parse/durable state failure REQUEST_FAILED.
No retry, reserve fallback, receiver consent fallback or model fallback. Durable
local permit consumption precedes provider transport and remains spent on failure.
Desktop owns OFF-default scheduling, online/in-use checks, reservation and publish.
Happy neither discovers assignments nor schedules probes. Server debit is authoritative;
provider machine/token ledger is an additional bound. No inference/network support
is inferred from synthetic tests. Automatic rotation and prepared-profile binding
remain separate pending work.

Process bound (integration): `cswap token-runtime collect-org` runs with a 30 s outer timeout and process-tree termination,
so a valid completion within the provider's 10 s signed HTTP deadline plus persistence reaches Core. Metadata reads keep 10 s.

Capability `collectorProbeVersion:1` appears only after marked provider org capability
and trusted-origin key validation; Desktop MUST preflight before reserve.

Local group identity compatibility: this Happy base journals the legacy managed-ID
hash; collector verifies it ONLY inside the exact company/user reconciled journal
and requires both desired and owned custody. It never trusts the caller's identity
hash and never treats server company-scoped refs as local runtime accountRef. Parent
company-scoped group identity migration must update all apply/snapshot/remove writers
together; no mixed-format journal migration is claimed here. Preexisting personal
slots without owned custody fail closed, even if present in desired assignments.

A crashed local `consume.lock` keeps collection unavailable until explicit operator
recovery preserving `permits.json`; no automatic lock deletion/replay ledger reset.
Signatures prove the server reservation snapshot, not immediate network revocation;
the provider and journal are checked again after transport and server publish must
still fence OFF/reassignment/revision. No fallback or retry performs another attempt.

Collector verification (2026-10-04): Happy typecheck and Vitest's required CLI build
passed after building the local `happy-wire` dependency. Six selected suites passed
282 tests: claudeCollector, aiCredentialGroups, RpcHandlerManager, serverLane,
aiCredentialSetupToken and aiCredentialRuntime. The collector suite included a real
installed-wheel subprocess roundtrip (isolated file backend, synthetic credentials,
all provider network entry points guarded/replaced by fake HTTP) and durable replay.
Use `COLLECTOR_PACK_PYTHON` and `COLLECTOR_PACK_INSTALL` to opt into that artifact test;
without these explicit local paths only that test is skipped. No home/Keychain/live
inference/daemon change/Studio bearer/publish was used. Existing pkgroll bin/empty-chunk
warnings remain; no TypeScript diagnostics. Provider commit: `6e9e43c`.

## Personal probe Core RPC v1 (UI contract)

Freshly nonce-bound customer-key `ai-credential:token-probe` request:
```ts
{version:1,operation:'status'|'consent'|'collect',accountRef:string,
 credentialGeneration:number,enabled?:boolean,ackCost?:boolean}
```
accountRef/generation are required for every operation. `consent` requires enabled;
enable additionally requires `ackCost:true`. Other operations reject enabled/ackCost.
Managed rows reject consent AND collect regardless of retained local consent. Status
is local/no-network and does not change consent. collect means explicit manual caller
action; no renderer poller/script schedules inference. Provider/Core shared machine/token
budgets, backoff and singleflight apply. Resident scheduling is implemented in Core as described below.

Success `{version:1,operation,accountRef,credentialGeneration,scope,enabled,ackCost,
status:'ready'|'disabled'|'backing-off'|'budget-exhausted'|'unavailable',reason,eligibility,
account:<whitelist>,budget:{minIntervalMs:300000,dailyLimit:96,remaining,retryAt,
machineRemaining,machineUsed24h,machineLimit24h:288,accountLimit24h:96}}`.
Account whitelist: accountRef,credentialGeneration,credentialType,probeEnabled,
authState,usageStatus,decisionEligible:false,reasonCodes,observation? (provider ISO UTC;
source,observedAt,windows[{kind,pct,resetsAt}],coverage:'unknown',reason,retryAt),
managedAccountId? for display-only status. No active/session binding claim or credential.
Errors `{version:1,status:'unavailable',error:'TOKEN_PROBE_...'}`:
INVALID_INPUT/GENERATION_CHANGED/ACCOUNT_NOT_FOUND/ORGANIZATION_COLLECTOR_REQUIRED/
COST_ACK_REQUIRED/RUNTIME_UNSUPPORTED/REQUEST_FAILED; provider stopped attempts use
BACKING_OFF/BUDGET_EXHAUSTED/COLLECTOR_BUSY/PROBE_DISABLED/ACCOUNT_DISABLED.
`tokenProbeVersion:1` requires marked runtime with setupTokenObservation,
durableProbeBudget and personalProbeVersion:1 (generation CAS). Desktop gates controls on this capability, not numeric version.

Prepared-profile note: Sol's interim refusal of binding (`a70da2d10`) is superseded and omitted in integration; binding is governed by the signed-grant gate above. Personal CAS provider
capability is `personalProbeVersion:1`, commit `6397291`; old marked artifacts without
this feature do not enable the new personal RPC.

Reproduction commands (Happy worktree):
```sh
pnpm -C packages/happy-wire build
pnpm -C packages/happy-cli typecheck
COLLECTOR_PACK_PYTHON=<provider-worktree>/.venv/bin/python3 COLLECTOR_PACK_INSTALL=<provider-worktree>/dist/pack-smoke/install pnpm -C packages/happy-cli exec vitest run --project unit src/daemon/tokenProbe.test.ts src/daemon/claudeCollector.test.ts src/daemon/aiCredentialSetupToken.test.ts src/daemon/aiCredentialRuntime.test.ts src/api/rpc/RpcHandlerManager.test.ts src/api/rpc/serverLane.test.ts src/daemon/aiCredentialGroups.test.ts
```
`pnpm install --frozen-lockfile --ignore-scripts --filter @buzzni/happy-cli... --store-dir .pnpm-store`
was local dependency preparation only; lockfiles unchanged and the generated store
is excluded from scoped commits. The required test build emits existing pkgroll bin
and empty-chunk warnings; these are not new TypeScript diagnostics.

Stable-ref discovery: existing `ai-credential:status {provider:'claude'}` adds
`tokenRuntime:{version:1,state:'available',accounts:[<personal account whitelist plus
number,roster:{email,organizationUuid,uuid},legacyUsageOwned:false>]}` only when the
marked observation artifact returns a valid local roster. No network, inference,
active-selection claim, or change to existing normal OAuth/API status fields.
`number` is a local selector only. Join by number AND exact roster metadata;
accountRef/generation are the mutation identity. Failed/unsupported roster reads
omit the additive field. Desktop's existing collector preflight reads this field.

The per-handler customer-bound policy uses a refusing nonce guard even under compat:
a full window never evicts protected consent/probe nonces. Its latest RPC manager and
server-lane suites passed 46+4 tests. Organization+personal installed-wheel roundtrip
passed; combined provider machine spending was 2, and no credential reached stdout.
The final focused collector/personal/capability suites passed 16+7+18 tests before
the additive roster discovery change. Discovery and legacy status regression results
are recorded below after their final run. The actual Studio public HTTP gate remains
unverified by this worktree; no bearer workaround is used.
Final additive roster/personal regression: tokenProbe 8, aiCredentialSetupToken 18,
aiCredentialRuntime 193 = 219 passed; required build/typecheck passed. No normal
OAuth/API status was replaced. Final relevant suite counts across the implementation:
claudeCollector 16 (including explicitly enabled installed-wheel org+personal smoke),
aiCredentialGroups 7, RpcHandlerManager 46, serverLane 4, tokenProbe 8,
aiCredentialSetupToken 18, aiCredentialRuntime 193. The final focused runs above
cover each changed behavior; these counts are not a claim of a repository-wide run.

## Resident personal scheduler and DTO alignment (current)

Core trust origin is `HAPPY_APLUS_STUDIO_ORIGIN`, matching prepared-profile verifier
configuration. No MCP-config URL fallback or caller origin/key is trusted. Missing
config/key omits collectorProbeVersion before Desktop reserves. No Studio bearer.

Collector request exact fields now include BOTH accountRef and permitId:
`{version:1,companyId,userId,machineId,managedAccountId,accountRef,
credentialGeneration,policyRevision,permitId,grant}`. The signed permitId matches;
accountRef must equal the unique local roster row for that managed ID/generation.
Success adds `status:'observed'` to the scoped epoch-ms observation response.
Before invoke now < transportDeadline; after invoke observedAt must be within the
transport deadline and result delivery now < expiresAt. The publication grace
never authorizes an additional inference attempt.

Personal success adds top-level `{scope:'personal',enabled,ackCost,status,eligibility,
budget:{minIntervalMs:300000,dailyLimit:96,remaining,retryAt,machineRemaining,
machineUsed24h,machineLimit24h,accountLimit24h}}`, preserving operation/account/ref/
generation for compatibility. Status is the five-value normalized probe eligibility mapping, never usageStatus; eligibility is eligible/disabled/managed/account-disabled/
scope-missing/backing-off/budget-exhausted. Managed read-only status says organization;
consent/collect reject it. retryAt is epoch-ms|null, not a credential or local digest.

These values derive ONLY from provider integration6a930c9's probeBudget scope
local-per-token/accountUsed24h/accountLimit24h/accountRemaining24h/nextProbeAt/
failureStreak/minIntervalSeconds/recommendedIntervalSeconds plus status.budget
machineRemaining24h/machineSlotFreesAt. Missing/invalid budget metadata fails closed;
no competing provider budget DTO. Account slot-frees time is not exported, so exhausted
account retryAt is unknown(null) and eligibility remains budget-exhausted. Machine
exhaustion uses the actual machineSlotFreesAt. No guessed remaining or reset time.

Daemon resident scheduler polls local metadata every5s ONLY online and during actual
live/fresh Claude session use. Default OFF uses provider durable consent; enable
still requires ackCost:true. Collection starts no more often than15min/ref and
respects durable token retry and account/machine budgets. It checks current ref/gen
and generation CAS; one shared runtime operation queue and provider collector lock
serialize organization/personal/manual work. No renderer inference loop.

Revoke cancels before consent waits in the queue. Group-sync/apply/purge cancel
before replacement waits. Offline/inactivity/observed generation replacement abort
at the next5s daemon tick; transport processes are killed and late results discarded.
Cancellation after reservation never refunds/reset spending. Shutdown/update/startup
failure closes the scheduler. Stale/recovered/missing runtime reports and managed
runtime sessions never count as personal in-use. Actual use is thinking/open tool/
pending user input or user interaction within15min, with live PID and <=120s runtime
report. Injected fake clocks/gates test these decisions; no live daemon was replaced.

UI normalization (authoritative current mapping): top status is exactly
ready|disabled|backing-off|budget-exhausted|unavailable, from probe eligibility,
not cached usageStatus. reason is a bounded fixed or validated observation reason:
not_observed/probe_disabled/backing_off/budget_exhausted/organization_collector_required/
account_disabled/authentication_failed/inference_scope_required or safe provider reason.
Nested account keeps authState and usageStatus separate. Disabled manual collect
returns status disabled without a transport call. Machine remaining is validated0..288;
UI canCollect must require both budget.remaining>0 and budget.machineRemaining>0.
Duplicate stable refs fence discovery/scheduling and cancel pending work.

Final scheduler/DTO verification (2026-10-04):
```sh
pnpm -C packages/happy-cli typecheck
COLLECTOR_PACK_PYTHON=<provider-worktree>/.venv/bin/python3 COLLECTOR_PACK_INSTALL=<provider-worktree>/dist/pack-smoke/install pnpm -C packages/happy-cli exec vitest run --project unit src/daemon/personalProbeScheduler.test.ts src/daemon/tokenProbe.test.ts src/daemon/aiCredentialRuntime.test.ts src/daemon/claudeCollector.test.ts src/daemon/aiCredentialSetupToken.test.ts
```
249 passed (scheduler9, personal9, runtime195, collector18, setup-token18), no
artifact skip in this explicitly configured run. Actual installed marked wheel,
isolated file backend/fake HTTP exercised org+personal spending, default-OFF and
online/in-use scheduler admission, generation CAS and response whitelisting. Grace
regressions accepted captured observation delivery at10.001s and rejected30s expiry.
Provider budget commit `3d2d6c3` passed68 focused tests, lint and wheel/sdist smoke;
its budget schema duplicates integration6a930c9, so retain the integrated equivalent.

No live inference, home/Keychain, daemon replacement, server/public-key live request,
release pin, publish/push/merge or operating migration. Parent combined integration
and release pin remain unverified; source/fake transport tests are not deployment
or provider-authorization evidence. Existing pkgroll bin/empty-chunk warnings remain.
Final additional account-disable cancellation regression: scheduler suite10 passed
with required build/typecheck. Provider reservation/backoff remains spent on abort.

Queued cancellation fence: every collect captures per-ref and global cancellation
epochs at entry, before shared serialization. OFF increments the ref epoch immediately;
replacement/apply/group-sync/purge, offline/inactivity and shutdown increment the
shared cancellation epoch. A queued collect with changed epoch or aborted scheduler
signal returns TOKEN_PROBE_CANCELLED before ANY provider invocation, including
capability/status. Ref revocation returns status disabled/reason probe_disabled;
other cancellation returns unavailable/cancelled. No budget/consent acknowledgment
is invented; OFF's own RPC still commits durable consent separately. Active process
abort is unchanged. Epoch compaction is bounded and advances the global fence so an
old queued epoch cannot become valid again. Internal epochs are not public grants.

Final queue-fence verification (2026-10-04):
```sh
pnpm -C packages/happy-cli exec vitest run --project unit src/daemon/aiCredentialRuntime.test.ts src/daemon/personalProbeScheduler.test.ts src/daemon/tokenProbe.test.ts
```
216 passed: runtime197, scheduler10, personal9. Both deferred organization-lock
regressions (manual collect → OFF and manual collect → offline) verify zero provider
commands from the cancelled job. Existing active-process abort regression passes.
Required CLI build/typecheck passed; existing pkgroll bin/empty-chunk warnings only.
`git diff --check` passed. This final patch changes queue admission only; installed-wheel
fake-HTTP evidence for the preceding scheduler/DTO implementation is recorded above,
not repeated as live evidence. Generated `.pnpm-store/` remains unstaged.

## Fresh Happy self-review (2026-10-04)

Initial fail-closed gaps were reproduced before correction (7 failing regressions,
45 existing setup-token tests passing). Collector configuration previously reduced
an arbitrary URL to its origin before validation, accepting userinfo, paths, query
and fragments that the binding verifier refused. Collector capability and probe now
reuse `readTrustedStudioOrigin` against the sole `HAPPY_APLUS_STUDIO_ORIGIN` input.
Malformed configuration performs no public-key request. Binding nonce ledger reads
now reject arrays, non-lowercase-UUID keys and nonpositive/unsafe expiries before
pruning or writing; corrupt state stays intact and cannot return a token environment.

Fresh focused verification: 10 suites, 458 passed and 1 skipped (installed-provider
collector artifact test requires explicit artifact environment). Suites cover runtime,
setup-token bindings/proofs, group custody, session environment/hydration, personal
scheduler/probe, collector and RPC authorization. `pnpm -C packages/happy-cli typecheck`
and the test global setup's CLI build passed. Existing pkgroll bin/empty-chunk warnings
remain; no CLI lint script/config is defined. `git diff --check` passed.

This review did not use live credentials/inference, replace the operating daemon,
change release pins or perform publish/push/merge. The existing single-daemon nonce serialization and direct-terminal scope limitations
remain unchanged. A further review found the binding nonce writer used rename without
fsync. Four additional failing regressions reproduced missing flush ordering and
unsafe success when durability hooks were absent or failed. Only the nonce writer now
flushes the temporary file before rename, then the ledger directory and its parent
before returning a token environment. Missing hooks or any flush failure return no
credential; a renamed ledger is never rolled back, retaining the consumed nonce.
Unsupported directory fsync fails closed rather than silently skipping durability.
Injected order/failure tests verify the protocol, not actual power-loss simulation.

After the nonce flush correction: 462 passed, 2 explicitly environment-gated artifact
tests skipped across 11 selected suites (the prior ten plus the binding artifact
fixture). CLI build and separate typecheck passed; `git diff --check` passed. Both
artifact fixtures remain ready for a separately configured installed-provider run.

## Repeated self-review round 1 (2026-10-04)

New P2 finding: hydration sanitized a malformed saved setup-token binding away before
`readSetupTokenResumeSelection` could reject it. That made a previously bound session
look unbound; if its managed assignment was revoked and a machine default became
available, resume could choose a different credential. Generic environment capture now
retains a bounded empty invalid marker when a present binding fails sanitization, so the existing
resume guard rejects it. Valid bindings and genuinely absent bindings are unchanged.
Five boundary regressions (partial JSON, non-JSON, empty string, null and number) failed
before the fix. Production runtime construction already supplies both nonce fsync hooks;
remaining hook-less fixtures never request a setup-token binding. Owner/generation and
OFF/queued-collection paths yielded no additional concrete finding in this round.

Round 1 validation: 381 tests passed across seven focused suites (hydration, session
environment, setup-token runtime, general credential runtime, auth wiring, personal
scheduler and token probe). CLI build, separate typecheck and `git diff --check`
passed; pre-existing pkgroll warnings only. No live runtime or external mutation.

Follow-on caller audit broadened this same P2 fix to `captureSaycodeAgentEnvironment`,
which serves both final-spawn tracking and persisted hydration. A hydration-only marker
could be dropped by another capture. Five new capture/re-capture cases and the updated
existing capture assertion failed before moving the marker to this shared boundary.
The redundant hydration special case was removed. Corrupt bytes are never retained;
valid binding, request scrub and absent-binding behavior remain unchanged.

Shared-capture follow-on validation: 180 tests passed across seven suites covering
capture/session environment, hydration, setup-token binding, auth wiring and the
checkpoint/write-scope consumers of capture. Separate typecheck, mandatory CLI build
and `git diff --check` passed; existing pkgroll warnings only. This is the same medium
severity finding, not an additional issue or authority change.

## PR branch update against main (2026-10-04)

Merged `origin/main` at `ec5c82428` into the reviewed integration branch (`9a55ad32f`)
without conflicts. Incoming CLI changes add Codex MCP preparation timing and browser
CJK fonts; server monitoring adds GC/event-loop metrics. None changes setup-token
binding, session environment capture, custody or collector authorization. The CLI
version `1.1.10-aplus.286` is inherited from main, not a new release/pin decision.

Post-merge validation: 13 focused CLI suites passed, 538 tests passed and one
installed-provider collector fixture skipped because its artifact environment was
not supplied. Coverage includes setup-token/proof/session hydration and environment,
custody/runtime/RPC, personal scheduler/probe, collector, plus incoming Codex MCP
recovery/latency and browser image policy. Mandatory CLI build and separate
`pnpm -C packages/happy-cli typecheck` passed. Existing pkgroll bin/empty-chunk
warnings remain. Diff whitespace and unresolved-conflict checks passed. The prior
actual-wheel integration evidence was not rerun or relabeled as post-merge evidence.
No operating daemon, live credentials, runtime pins, publish or push was changed.

## Post-merge packed candidate and CI follow-up (2026-10-04)

Happy runtime source `822948b9613d03563a688c87f5015bb2386517ed` was prepared with
`prepare-publish-package.cjs`, packed, and installed with lifecycle scripts disabled
into `/private/tmp/happy-final-candidate.b4xsdv/install` (not a global install).
Tarball `/private/tmp/happy-final-candidate.b4xsdv/buzzni-happy-cli-1.1.10-aplus.286.tgz`
SHA-256: `03e1368e3955ad7c2ba1d9d4e566d3a5f6d529d41664be2ae7e826effa0c2d62`.
Artifact guard validated 12 required bundled files; installed production dependency
closure passed. macOS `/tmp` alias initially confused npm's file dependency locator;
reinstalling the same tarball with canonical `/private/tmp` paths resolved it.

Actual installed binary reported version `1.1.10-aplus.286` and `Not authenticated`
under a clean environment and isolated empty state. Repeat the non-daemon smoke with:
```sh
env -i PATH=/usr/bin:/bin HOME=/private/tmp/happy-final-candidate.b4xsdv/home \
  HAPPY_HOME_DIR=/private/tmp/happy-final-candidate.b4xsdv/state \
  XDG_CONFIG_HOME=/private/tmp/happy-final-candidate.b4xsdv/config \
  HAPPY_SERVER_URL=http://127.0.0.1:1 \
  /Users/justin/.hermes/node/bin/node \
  /private/tmp/happy-final-candidate.b4xsdv/install/node_modules/@buzzni/happy-cli/bin/happy.mjs auth status
```
Substitute `--version` for `auth status` for version-only smoke. This recipe never
starts a daemon; no existing service or credentials are used. Installation skipped
native/postinstall lifecycle scripts, so these checks do not assert a fully operational
PTY/daemon installation. No runtime pin or release was changed.

Post-merge actual-wheel tests passed 19/19 across binding artifact and collector
suites, without skips. Provider wheel `claude_swap-0.27.0b1-py3-none-any.whl` SHA-256
`87501a7d4df6e59f2734170204cfceca5cfe66f15b5f8bc39ea201d10d97bfea` contains runtime
source `2fef57e` (provider HEAD `6baf237` adds provenance documentation only).
Collector imported the fresh target `dist/isolated-provider-mq32f4vu/pack-smoke/install`;
binding installed the same wheel into its own temporary file-backend home. Six network
attempts were intercepted and blocked by the binding harness; collector used guarded
fake HTTP. Build/typecheck within test setup passed with existing pkgroll warnings.

PR #684 Linux Node20/24 and Windows Node20/24 passed. macOS run37173720779 failed
one stale test out of 10422: `installCompanionTools.test.ts` searched source for the old
inline version regex removed by this feature. Local focused RED reproduced 1 failure,
37 passes. The test now invokes `parseCswapVersion`/`cswapAtLeastPinned` against the
installer pin, a newer marked-build version, and an older rejected version; runtime
code/artifact bytes remain unchanged. This is a scoped test correction, not a release
pin change. Fresh remote CI is required after pushing that correction.

CI correction GREEN: 94/94 passed (installer script38, setup-token runtime56),
mandatory CLI build/typecheck passed, diff whitespace clean. The isolated candidate
state contains no daemon.state.json. Remote CI has not yet rerun for this test-only
correction; the failed macOS run remains the last remote result until a new push.


## Actual installed daemon DEK RPC acceptance — 2026-10-04

Latest e34cde5ff CI passed all five Linux20/24, Windows20/24 and macOS jobs;
the earlier macOS source-regex failure above is historical. Candidate runtime
remains822948b96; subsequent changes are tests/documentation only.

The same installed CLI tarball and provider wheel were exercised with an actual
source standalone PGlite server and daemon under a unique temporary HOME.
A first secretbox/legacy run was not counted as Desktop DEK acceptance. A fresh
run used credentials without `secret`, registered a wrapped machine DEK, and
sent customer-bound AES-256-GCM RPC ([0|12-byte nonce|ciphertext|16-byte tag]).
Capabilities, reconciled group-sync/status for one synthetic managed account,
collector observed45% plus permit-replay rejection, and signed session spawn
with appliedAiAuthSource=org-bundle succeeded. Both the Happy child entry and
actual Claude fixture executable observed the matching token (boolean only),
nonce/generation binding and empty API-key/baseURL overrides.

Session stop and daemon stop returned200; wrapper and server stdin EOF exited0
with no signal. Actual daemon/wrapper/child PIDs were absent and no fallback
cleanup ran. Node net/DNS denial instrumentation recorded no denied attempts;
the Python external inference transport was mocked exactly once. This is a
harness network boundary, not OS-wide isolation acceptance. Evidence:
`/tmp/claude/happy-dek-acceptance._qu85ev6/{harness.cjs,network-guard.cjs,result.json}`.
Parent reviewed source/result and independently asserted the outcomes and exits.

Studio signing/public-key/grants and inference remained fixtures. Desktop's
actual callDesktopGroupMachineRpc was not invoked (an independent matching-wire
client was used). Real Studio reserve→daemon→publish, real Claude authentication,
model coverage, native postinstall/release package/rollback and runtime pin
acceptance remain open. Real account requests:0. No product code or operating
daemon/pins changed.
