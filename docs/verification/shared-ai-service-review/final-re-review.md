> 历史验证记录。文中的 W 和临时绝对路径指当时的验证目录。保留的输出见本目录下的日志文件夹。各阶段结论以该阶段提交为准。

**I1 — Definitive provider-admission refusal occupies advisor capacity: ADDRESSED.** `A/paws-service.mjs:98,103,122,127,136` now releases fresh, matching, proven refusals and replays durable rejection records. Existing uncertain rows retain their original input and payload. `P/packages/happy-server/sources/app/api/routes/sharedAIServiceRoutes.ts:61` adds the scoped admission marker; `P/packages/paws-agent/src/services/nodePlatformHandler.ts:125` carries it through the host bridge. `A/test/paws-service.test.mjs:137` covers permanent model refusal, restart, local retry/read/cancel, released capacity and exclusion of rejected messages from future context. The HTTP case covers deletion. This closes the original sequential refusal defect; new concurrent certainty defect N1 remains open below.

**I2 — Browser-local validation creates an immutable uncertain request: ADDRESSED.** `A/public/ai-service.js:45` validates the full supplied message array before saving pending state. This includes personal accumulated history. `A/public/chat.js:320` derives busy state from the remaining journal entry. Draft and attachments are cleared only after a successful start. Installed-package regressions at `A/test/ai-service.test.mjs:277` cover aggregate images, personal history, corrected input, zero transport calls and response-loss retention. N1 concerns the new rejection-clearing branch, not this local-validation path.

**I3 — A concurrent duplicate start returns an empty terminal answer: ADDRESSED.** `P/packages/paws-agent/src/services/scopedTransport.ts:268` reads and verifies the encrypted persisted snapshot when POST returns a running or terminal record. The added race test in `transportContract.test.ts:82` exercises two POSTs with the same ciphertext, one modeled execution, equal decrypted answers and sequence 7. Both consumers contain the refreshed installed SDK bytes. The original fabricated terminal snapshot is removed.

**I4 — Native and probe errors lose their public recovery category: ADDRESSED.** `P/packages/happy-cli/src/daemon/appDelegation/nativeServiceErrors.ts:8,20` maps explicit structured fields to an allowlisted public category. Codex execution/discovery and Claude assistant errors use it. `executionBinding.ts:38` no longer guesses login from diagnostic substrings. `P/packages/happy-server/sources/app/aiServices/probes.ts:30,70` validates and preserves safe codes. Process-fixture tests cover quota/login/model/protocol and unknown diagnostics; `transport.spec.ts:128` covers actual probe-route identity/protocol round trips. I checked the retained Codex 0.159.3 schema and installed Claude SDKAssistantMessageError declaration. This establishes the local translation contract, not real provider acceptance. CLI test output evidence is qualified below.

**I5 — Required third migration omitted from release inventory: ADDRESSED.** `P/docs/releases/shared-ai-services-candidate.json:381` includes the conversation-creation migration. `P/docs/releases/shared-ai-services.md:59` and `A/docs/verification/paws-services-rollout.md:63` specify all three in order. `P/scripts/verify-shared-ai-migrations.mjs:9` compares the inventory with migrations added since the reviewed base, then checks file hashes. I independently checked all three hashes. No database migration was run.

**M1 — Scope acknowledgement uses radio semantics: ADDRESSED.** `P/packages/happy-app/sources/components/aiServices/ServiceEditor.tsx:111` now supplies `role="checkbox"`. The changed component test checks this role, and the retained App log reports both tests passing.

**M2 — Dense integration harness obscures failures: ADDRESSED.** `P/packages/happy-server/sources/app/aiServices/smokeAcceptance.spec.ts:1` adds explicit SDK/client, database, binding, catalog and worker-claim types. The worker and assertions are expanded into distinct stages. Runtime imports still resolve the installed SDK. Actual HTTP routes, encrypted input/output, two application identities, response loss, cancellation, scope refusal and the second-app browser bundle remain exercised. Recorded final packed-harness output reports five passes and the intentional serve-only skip.

## New breakage in the fix diff

**N1 — Important: concurrent starts can falsely declare accepted work “not submitted” and discard its recovery journal.** Locations: `P/packages/paws-agent/src/services/scopedTransport.ts:273`, with the same stale-read decision at `P/packages/paws-agent/src/services/platformTransport.ts:98`; consequence at `A/public/ai-service.js:46`.

The new certainty decision checks only whether the earlier `storage.get()` returned an outbox. Two simultaneous starts can both read absence, then share the winner of `putIfAbsent`. Both still consider themselves fresh. Suppose the first POST is accepted but its response is lost, then authorization is revoked before the second POST. The route correctly says that the second invocation did not submit work. The second SDK call incorrectly promotes that invocation-level refusal into request-level certainty. The advisor's new journal catch then clears the original pending request, although the first execution was accepted.

This is the same supported shared-storage concurrency shape used by the I3 regression. It is introduced by the new submission marker and clearing branch. It is not a speculative third-party transport failure: the real start route can reject authentication before looking up an existing turn. The scoped client must account for overlapping submissions before treating that refusal as proof about the whole request.

**N1 focused check:** The installed Node package, with two direct concurrent starts and no storage barrier, produced two POSTs and these results:

```json
{"posts":2,"accepted":1,"results":[{"code":"transport-error","submission":"uncertain","requestId":"request"},{"code":"authorization-revoked","submission":"not-submitted","requestId":"request"}]}
```

**N1 consumer check:** The installed browser personal transport plus the actual advisor journal produced:

```json
{"posts":2,"accepted":1,"results":[{"code":"transport-error","submission":"uncertain"},{"code":"authorization-revoked","submission":"not-submitted"}],"pending":null}
```

The consumer probe uses a barrier only to arrange both initial outbox reads before insertion. Atomic `putIfAbsent` is unchanged. The fixture models one accepted response loss and one later scoped refusal. No network, host backend, browser, provider or persistent database is used. An initial unforced journal probe happened to serialize the reads and correctly retained pending state; the deterministic probe tests the valid overlapping ordering. Exact reproducer: `W/final-certainty-race-probe.mjs`. Recorded output: `W/final-certainty-race-probe.json`. Run with `node W/final-certainty-race-probe.mjs`, expanding W as defined below.

**N1 fix direction:** Derive certainty from atomic ownership and durable submission provenance, or coordinate each request across shared-storage users. A stale absent read is insufficient. A loser or overlapping attempt must not clear the recovery record while any attempt may have been accepted. Preserve the original ID and ciphertext. Add the accepted/lost plus refused concurrent case to the transport contract and actual journal tests. Cover both scoped and browser-platform certainty handling. Repack both consumers if SDK bytes change.

**N2 — Minor: refreshed release description retains the old SDK file count.** `P/docs/releases/shared-ai-services.md:15` says 45 files. The replacement tarball and updated candidate inventory contain 43 regular files. Independent byte comparison found all 43 installed files correct in both consumers. This is a documentation mismatch, not missing package contents. Update the count to match the final artifact, preferably deriving it from the candidate manifest.

## Checks and evidence limits

- **Scope check:** Reviewed the supplied fix packages for Paws `12c4b75141a3a62f9918d9822fd00d6bfdff6b57..2f051d6747e9689146d35a82d72db0f112732316` and advisor `daaa1193658b11028c965dd357272e3385001962..3b1a2c1e315c39bec00ab03f91f6617e7473be58`. Used bounded source/test/document passes. No new whole-branch review or git rerun was performed.
- **Path check:** P is `/Users/jacky/jacky-github/happy--shared-ai-services`; A is `/Users/jacky/jacky-github/relationship-advisor--paws-services`; W is `P/.superpowers/sdd/2026-10-05-paws-shared-ai-service`.
- **Test-output check:** Read `W/final-validation-logs/`. Retained logs show Server 13 passed/1 skipped; final installed-package harness 5 passed/1 skipped; App 2 passed; advisor full suite 94 passed/1 skipped; final journal 41 passed; final adapter 20 passed. The skipped harness case holds a browser fixture open. Changed tests match the claimed behaviors. These passes do not cover N1.
- **Build-output check:** Retained SDK, Server, advisor and final Expo Web export logs agree with the reported local builds. Server output includes its typecheck and 143-module runtime bundle. Existing pkgroll/Zod/Watchman/export warnings remain visible. No suite or build was rerun by this reviewer.
- **Evidence qualification:** SDK 27-test and CLI 32-test output is absent from `final-validation-logs`. The controller identifies transcript exec 60859, SDK chunk badd77 (6 files, 27 tests, 05:23:09, 2.55s) and CLI chunk 95deae (4 files, 32 tests, 05:23:13, 50.30s), including CLI setup/build/typecheck. These are controller-attested transcript results, not independently inspected retained log files in this re-review. The report's blanket statement that outputs were preserved in the log directory is too broad. No rerun was requested merely to reproduce those outputs.
- **Artifact check:** Both durable SDK tarballs are 191,348 bytes with SHA-256 `d3b126c9da01aeb0eef919fba47fc9a2cb561e035864b99d345104751e735f5a`. Both panel tarballs match `336608ab2da2c24fca13543df030421de932d3ae18a2b42adba9cde67b3954ce`. All tarball regular files match both installations byte for byte (SDK 43, panel 8). Both lockfiles match their tarball SHA-512 integrity. Advisor generated client SHA-256 matches `c36f86acae6cc519da39275fd071768fd1239ab44d3458c856945bae51266687`.
- **Native-schema check:** Retained Codex schema SHA-256 matches `016870158603b0f84bd9f8f65f927161c9fd5128e5ec632087616462dc44e085`; its explicit error variants match the mapper. The installed Claude declaration lists the mapped assistant-error enum values. Unknown values and diagnostics remain generic.
- **Browser-evidence check:** Read controller-owned `W/final-browser.md`. It records final synthetic advisor mobile-Web checks for oversized local input, fresh rejection/capacity, response-loss recovery and layout. It explicitly replaces an invalid post-initialization fetch metric. This reviewer did not operate or independently observe a browser. The evidence does not cover native phone or real personal authorization.
- **Boundary check:** The fix diff does not add billing limits, default-account substitution, fallback engines/devices/payers or new permissions. Exact binding and recipient-key boundaries remain intact in the amended paths. N1 nevertheless breaks the required preservation of uncertain original requests.

## Out-of-scope observations

**None newly raised.** Original accepted build-warning debt and the two existing advisor high audit advisories remain under the controller's prior dispositions. They were not reopened or declared resolved. M1 and M2 are closed above.

## Declined to judge

- **Real acceptance remains unexecuted:** A1/A3/A4/A5 provider success, two real Codex identities and credential refresh, Claude login/execution, actual model/reasoning, A6 native-phone/real-personal pairing and persistence, full A9 legacy/direct/sharing, and owner daily use. Local schema/process fixtures and synthetic Web results cannot establish them.
- **Production and publication remain outside authorization:** actual production TLS/ingress/SHA/configuration, live database and backup/restore/drain, registry publication and final versions, panel release automation, deployment/OTA ordering and remote merge. Local review is not deployment approval.
- **Prior ruled exclusions remain:** arbitrary unsupported Claude/API-key/image/default configurations; ambiguous legacy credential cleanup; cross-device personal-history listing/deletion/sharing; long-term ciphertext reclamation; third-party advisory exploitability; unrelated T0 restyling/Tauri/other production consumers/billing/SSO. This scoped fix review supplies no new evidence for those set-asides.
- **Generated and third-party internals:** Source changes, build logs and exact artifact/install hashes were used instead of line-by-line minified-bundle, lockfile-dependency or full supply-chain review. This limitation does not excuse N2's count mismatch.

## Verdict

**Fix round: Findings remain open — N1 Important, N2 Minor.** I1–I5 and M1–M2 are addressed in their original direct failure cases. N1 prevents safe local completion of the coordinated fix. N2 does not independently block local integration. Production deployment and package publication remain blocked by the existing real-acceptance, operational and authorization gates.
