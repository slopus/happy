> 历史验证记录。文中的 W 和临时绝对路径指当时的验证目录。保留的输出见本目录下的日志文件夹。各阶段结论以该阶段提交为准。

# Final whole-branch review

Date: 2026-10-06. Verdict: **With fixes for local code integration; not ready for production.**

Reviewed Paws `f1fec57f212cf9ce8b4bd2788a3a955a3f93ea46..12c4b75141a3a62f9918d9822fd00d6bfdff6b57` and advisor `826a893..daaa1193658b11028c965dd357272e3385001962`. `P/` means `/Users/jacky/jacky-github/happy--shared-ai-services/`. `A/` means `/Users/jacky/jacky-github/relationship-advisor--paws-services/`.

The advisor range includes the approved merge of deployed `f0dbfff`. T0 records that the merge runtime tree equals that deployed tree. I distinguished that baseline from the new service work after `a0e7e10`. This review used the supplied whole-branch packages, final source, approved spec and plan, controller rulings, and recorded verification/release evidence. It concentrated on interfaces across tasks, rather than treating earlier task reviews as a final approval.

No browser, provider, production API, credential change, broad test rerun, subagent, product edit, index change, or HEAD change was performed. Three narrow Node probes used isolated in-memory state and installed public packages. Their results are recorded below. Existing Watchman cookie files were left untouched.

## Strengths

- The server rechecks persisted grants, exact target tuples, ownership, app identity and permissions. A client-supplied scope is not sufficient authority. Scoped tokens are excluded from the owner authentication path.
- Binding and revision records are immutable. Live daemon observations occur outside the database transaction, followed by identity and revision revalidation. The Codex credential path resolves the authorized profile and its current credential version, independently of the machine default.
- Personal message keys remain in recipient-sealed envelopes. The platform bridge requires host session and conversation ownership checks. The advisor supplies those checks and keeps history migration consent separate from binding creation.
- Lost-response recovery persists application IDs, request IDs and ciphertext. The new protocol cannot silently reuse old delegation permissions. Restricted runtimes disable tool surfaces and report unknown actual configuration as null.
- Both consumers retain the same durable package bytes. The release and acceptance documents clearly distinguish synthetic evidence from provider/native-phone acceptance and keep publication and deployment blocked.
- The deferred worker TTL defect is fixed in the actual publish transaction. `P/packages/happy-server/sources/app/aiServices/turns.ts:155` renews liveness only after current lease, deadline, authority and output checks. The recorded PostgreSQL barrier test also covers the new worker-lock order.

## Issues

### Critical (must fix)

None found in the reviewed scope. This is not a claim that unexecuted provider or native-phone paths are safe or complete.

### Important (should fix before local integration)

#### I1. A definitive provider-admission refusal can permanently occupy advisor capacity

**Locations:** `A/paws-service.mjs:128`, `A/paws-service.mjs:137`, `A/server.mjs:159`.

`prepare()` reserves messages and marks the conversation running before calling the SDK. The catch finalizes only a fresh `invalid-request`. Other explicit admission failures, such as `model-unavailable`, `parameter-unsupported`, `service-disabled`, or `machine-offline`, leave a pending row with no upstream turn ID. The service can return these before it inserts any turn. A permanently unavailable model cannot be corrected on the immutable binding. Cancel tries to read the nonexistent turn, deletion is blocked, and the user's other conversations are rejected by the active-capacity guard. Two affected users can occupy the application's two slots indefinitely.

**Focused evidence:** Ran the real advisor adapter against in-memory SQLite with two owned conversations and a typed, non-retryable `model-unavailable` result from a fresh SDK start. No provider work was accepted. Output:

```text
START one model-unavailable
START two resource-busy
saved: conversation=one, status=pending, turn_id=null
conversation one=running; conversation two=idle
CANCEL invalid-request
provider admission attempts 1
```

**Fix direction:** Carry a reliable distinction between an admission rejection and an uncertain submission through the SDK/adapter. Finalize proven fresh refusals and release local capacity. Keep ambiguous or previously persisted submissions fenced and recover them with the original request ID. Do not treat every non-retryable error as proof of non-acceptance. Add a regression for a permanently invalid bound model, cancel/delete after rejection, another conversation's capacity, and an accepted-but-response-lost countercase.

#### I2. Browser-local validation failures become immutable “uncertain” requests

**Locations:** `A/public/ai-service.js:43`, `A/public/ai-service.js:44`, `A/public/chat.js:320`, `P/packages/paws-agent/src/services/platformTransport.ts:64`.

The journal saves a pending request before SDK validation. Every error then leaves `busy=true`. There is no operation to release a request known never to have been sent. This occurs without I1 or any server call. For example, the UI permits three images whose individual sizes are valid, while the SDK limits the combined serialized payload to 5 MiB. Recovery retries the same oversized contents forever. The user cannot remove an attachment, start another conversation, change source, or stop this request because it has no turn ID.

**Focused evidence:** Used `createAdvisorJournal` and the installed public browser-platform transport. Three syntactically valid image data URLs each contained 1,900,000 base64 characters, below the individual advisor size limit. The SDK rejected the aggregate payload locally:

```json
{"error":"invalid-request","posts":0,"pending":true}
```

The `serviceSend` catch then unconditionally sets busy, and `updateControls` disables editing/new conversation/source controls. The same journal behavior affects personal input validation and accumulated personal history.

**Fix direction:** Validate the full effective payload before committing an immutable pending attempt, or expose a reliable not-submitted outcome and a journal rejection transition. Restore editable draft/attachments and controls for proven local failures. Preserve the exact ID and contents after an actual uncertain submission. Test this boundary using the installed SDK, including cumulative history size and a response-lost control case. Fixing only the adapter's server-side rejection record does not fix this browser case.

#### I3. A concurrent idempotent start can report a completed turn with an empty answer

**Locations:** `P/packages/paws-agent/src/services/scopedTransport.ts:239`, `P/packages/paws-agent/src/services/scopedTransport.ts:266`; consumer consequence at `A/public/chat.js:319`.

Two concurrent starts can both read an absent outbox, then use the same `putIfAbsent` winner. Both take the POST path because `previous` remains null. If the original turn finishes before the second POST, the server correctly returns its existing completed record. The SDK nevertheless fabricates `sequence:0` and `text:''` for that record. The advisor regards it as terminal, saves the empty answer and stops observation. Idempotency prevents another model execution but fails to recover its result.

**Focused evidence:** Two concurrent calls to the installed Node transport shared one storage instance, binding and request ID. The route fixture returned accepted for the first POST and the existing completed record for the second, matching the server's duplicate-start behavior:

```json
{"posts":2,"reads":0,"results":[{"status":"accepted","sequence":0,"text":""},{"status":"completed","sequence":0,"text":""}]}
```

**Fix direction:** When a start response names an already running/terminal turn, read and verify its persisted snapshot before returning a `TurnSnapshot`, or return an authoritative snapshot directly from the start route. Do not invent an empty terminal result. Test the shared-storage race with a real encrypted final response and assert identical answer/sequence and one execution. Repack and validate both consumers if the SDK changes.

#### I4. Real runtime and probe errors lose the public recovery category

**Locations:** `P/packages/happy-cli/src/daemon/appDelegation/restrictedCodex.ts:78`, `P/packages/happy-cli/src/daemon/appDelegation/restrictedClaude.ts:67`, `P/packages/happy-cli/src/daemon/appDelegation/executionBinding.ts:38`, `P/packages/happy-server/sources/app/aiServices/probes.ts:30`.

The wire and UI expose distinct quota, login, model and protocol errors, but the native paths erase that information. All Codex RPC errors become `runtime-request-failed`; a failed turn becomes `turn-failed`. Claude result failures become `claude-login-or-runtime-failed`, which `safeCode` classifies as a login requirement even for another cause. No new native executor branch emits `quota-exhausted`. Separately, the probe store rewrites already-safe daemon codes such as `protocol-incompatible` and `account-identity-changed` into `execution-interrupted`.

**Effect:** A genuine quota exhaustion cannot reach the advertised quota state, and a known protocol/identity problem gives the wrong recovery action. This conflicts with the design's explicit error contract. The A8 synthetic test injects the final `quota-exhausted` code at `smokeAcceptance.spec.ts:126`; it does not exercise this missing translation. The acceptance documents correctly disclose that limitation, but it is also an implementation gap.

**Fix direction:** Parse the supported CLI's structured error fields into a small allowlisted set of public codes. Keep unknown errors generic and never expose raw diagnostics. Preserve validated safe error codes through probes. Add native-process fixtures for known quota/model/login/protocol errors and a probe round trip for identity/protocol failures. Real provider verification remains a separate gate after those tests.

#### I5. The release candidate omits a required third migration

**Locations:** `P/docs/releases/shared-ai-services-candidate.json:382`, `P/docs/releases/shared-ai-services.md:59`, `A/docs/verification/paws-services-rollout.md:63`.

The manifest and both deployment descriptions enumerate only the two October 5 migrations. The branch also requires `P/packages/happy-server/prisma/migrations/20261006000000_ai_service_conversation_creation/migration.sql:1`. It adds `appConversationId`, `creationInput` and the scoped unique creation key used by binding lookup/retry. Following the enumerated migration inventory leaves the final Prisma client and binding code incompatible with the database. A standard deployment that discovers all migrations may avoid this, but the reviewed candidate is incomplete and the explicit operator instructions are wrong.

**Fix direction:** Add the third ordered migration and its actual SHA-256 to the candidate. Correct both rollout descriptions and the inventory check so it compares the manifest against every migration added by the reviewed range. Preserve the current no-production-migration boundary. This needs a focused inventory check, not another broad app build.

### Minor (nice to have)

#### M1. Scope acknowledgement has radio semantics

**Location:** `P/packages/happy-app/sources/components/aiServices/ServiceEditor.tsx:111`.

The standalone acknowledgement toggles independently, but `AuthorizationChoice` defaults to `role='radio'` at `P/packages/happy-app/sources/components/appAuthorization/AppAuthorizationLayout.tsx:69`. Assistive technology describes the wrong interaction. Pass `role="checkbox"`, as the extra-target and image consent choices already do. This is the deferred T7 M1; it does not weaken server authorization.

#### M2. The integration harness is unnecessarily difficult to diagnose

**Location:** `P/packages/happy-server/sources/app/aiServices/smokeAcceptance.spec.ts:30`.

The worker loop, crypto handling and assertions are compressed into dense lines with broad `any` state. Failures in an important cross-application boundary test are harder to localize. Format the existing flow, name response/assertion stages, and type the core fixture records. Keep the actual route and installed-package coverage. This is deferred T10 M1; it is not evidence that the five recorded cases failed.

## Deferred-item triage

Every deferred item from `final-review-context.md` is addressed here.

| Deferred item | Disposition | Evidence and remaining action |
| --- | --- | --- |
| T2 M1: Prisma generation deprecations | Accept as existing nonblocking maintenance debt | T2 generation passed; no schema-generation failure is shown. The separate missing release migration is I5, not this warning. |
| T3 M1: pkgroll bin-outside-dist/empty chunks | Accept as existing nonblocking build debt | T3 final CLI build/lifecycle checks passed. No new entry-point failure was established. Clean up in a packaging change. |
| T4 M1: worker activeUntil not renewed | Closed by T10 | Final publish code renews it after valid authority/lease checks. Recorded PGlite and real PostgreSQL lock-barrier evidence cover renewal and refusal of stale leases. No blind rerun was needed. |
| T4 M2: Prisma/pkgroll notices | Accept as duplicates of the T2/T3 debt | Same warning classes; no additional behavior defect established. |
| T5 M1: pkgroll/Prisma notices and bundled Zod cycle | Accept as nonblocking candidate build debt | Recorded public ESM/CJS/browser/types checks and both consumers' installation/build evidence pass. This is not a guarantee for future package versions; retain packaging validation when repacking for I3/I4. |
| T6 M1: CSS/package metadata and five bare-import warnings | Accept as nonblocking candidate packaging debt | CSS is explicitly copied, exported and present in the reviewed tarball. Recorded extracted-package lifecycle checks and both browser builds passed. No ignored import was shown to supply required initialization. |
| T7 M1: standalone acknowledgement radio role | Open, M1 above | Current source still omits the checkbox role. |
| T7 M2: renderer/Expo dependency export/environment warnings | Accept as existing nonblocking validation debt | Recorded component tests and final full Web export passed. Not native-phone acceptance. |
| T10 M1: dense smoke harness | Open, M2 above | Current source confirms the maintainability issue. |
| T10 M2: advisor dependency audit warnings | Retain as existing unresolved security maintenance; no clean-audit claim | T0 recorded two high advisories before new service work. No advisory/remediation or exploitability audit was performed by this review. Track separately before production risk acceptance; do not silently call them fixed. |
| T11 M1: Watchman fallback/color warnings | Accept as nonblocking local build-environment debt | The recorded final export exited 0 after Metro's Node fallback, with file counts and hashes retained. No claim of warning-free output or native acceptance. |

## Recommendations and verification scope

Address I1–I5 in one coordinated wave. I1 and I2 need a shared, precise concept of submission certainty; otherwise one layer will continue to infer acceptance from a generic error code. Keep all existing response-loss and immutable-binding guarantees. I3 needs a final-result read, not another model call. I4 must sanitize structured errors without making unsupported provider claims.

The three review probes above are additional focused evidence, not replacement acceptance suites. Other tests/builds were assessed from the existing T5/T6 package evidence, T9 final 64 affected tests and build, T10 actual-route/packed-SDK cases, targeted PostgreSQL liveness barrier, Server type/runtime build, and T11 Web export/artifact checks. I did not rerun unchanged broad suites. The browser evidence belongs to the controller's Ego checks; I did not operate or independently re-observe a browser.

After fixes, rerun only affected behavior/contract tests, regenerate changed package artifacts, and verify both consumers use the new same hash where applicable. Update release evidence to the final reviewed commit. Preserve the existing tarball provenance limitation: these local candidates have no published tag or package gitHead.

## Declined to judge

These are explicit set-asides for controller ruling, not silent approvals.

- True upstream success for A1/A3/A4/A5: no trusted real central-account execution chain was available to this review; the two real Codex identities, Claude login/execution and actual model/reasoning remain unexecuted gates.
- Real personal desktop/phone pairing, remember/revoke and native A6: only recorded synthetic/Web evidence is available. A phone-sized browser is not native-phone acceptance.
- Complete A9 legacy personal, direct API and sharing execution: the deployed T0 baseline and compatibility dispatch were inspected, but full real end-to-end paths were not executed. Keep the existing NOT EXECUTED status.
- Owner daily-use acceptance: no owner feedback was provided. No technical result substitutes for it.
- Production TLS/ingress, actual Server release SHA, live database contents, backups, drain and restore: prohibited external/production work in this review. The release gates must remain open even after I5 is corrected.
- Registry publication, final versions, panel release automation and Web/OTA deployment ordering: preparation only was authorized. No publication or deployment readiness follows from local imports/builds. A main merge may trigger deployment, so “local integration ready” is not permission to merge remotely.
- Existing advisor audit advisories' exploitability and remediation: no full dependency-security investigation was authorized or conducted. The two baseline high warnings remain visible maintenance/risk items, not newly introduced findings or resolved vulnerabilities.
- Supporting arbitrary Claude CLI versions, API-key identities, images or a native default whose identity/model cannot be verified: the current adapter intentionally has a limited alias catalog and fails closed. I did not infer unsupported capabilities from it or propose a guessed default. Real Claude acceptance must establish the supported subset explicitly.
- Automatic cleanup of legacy credential jobs with ambiguous process evidence: the controller expressly chose retention over unsafe credential deletion. The retained-job/manual-recovery cost is accepted under that ruling.
- Cross-device listing, remote deletion and new sharing for new personal histories: explicitly excluded by the controller's local-index/local-removal ruling. I checked the local-only wording and did not expand it into a new remote-history API requirement.
- Long-term remote ciphertext reclamation at the existing storage ceiling: the new protocol retains a resource cap and does not add remote deletion. I did not approve unlimited lifetime storage or a cleanup policy; operator lifecycle work remains outside this first-consumer review and must not silently discard bindings/keys.
- Line-by-line review of generated/minified bundles and lockfile dependency internals: source/public-entry checks and recorded reproducible build/package hashes were used instead. This does not assert a full third-party supply-chain audit.
- Restyling unrelated deployed T0 auth/direct/Glass UI code, Tauri support, quotas/billing/SSO and additional production consumers: outside the approved first-advisor scope. Existing host authentication and resource guards were inspected at the integration boundary.

## Assessment

**Ready to merge local code? With fixes.** The authority and credential architecture is substantially coherent, but I1–I4 leave observable recovery/result/error defects and I5 makes the release inventory inaccurate. Resolve those important findings before treating the local branch as complete. M1/M2 and accepted warning debt do not independently block local integration.

**Ready for production or package publication? No.** A1/A3/A4/A5/A6/A9 real acceptance, owner daily use, trusted HTTPS/credential provisioning, native phone checks, actual deployment/backup/drain records, final versioned artifacts and explicit release authorization remain required. None of the synthetic passes or this review closes those gates.
