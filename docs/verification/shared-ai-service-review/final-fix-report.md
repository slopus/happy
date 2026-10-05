> 历史验证记录。文中的 W 和临时绝对路径指当时的验证目录。保留的输出见本目录下的日志文件夹。各阶段结论以该阶段提交为准。

# Final coordinated fix report

Status: I1–I5 and M1–M2 addressed. Local implementation, self-review, tests, package refresh and documentation are complete. Controller review remains separate. Production and publication remain blocked.

## Commits and workspaces

| Workspace | Code/artifact commit | Final documentation commit / HEAD |
| --- | --- | --- |
| Paws `/Users/jacky/jacky-github/happy--shared-ai-services` | `a7557dc60f2c1d40f27a1ab00732e08c770cf1e8` | `2f051d6747e9689146d35a82d72db0f112732316` |
| Advisor `/Users/jacky/jacky-github/relationship-advisor--paws-services` | `1d5881100cacb4080aa682a6adb30887747872e7` | `3b1a2c1e315c39bec00ab03f91f6617e7473be58` |

Fix bases were Paws `12c4b75141a3a62f9918d9822fd00d6bfdff6b57` and advisor `daaa1193658b11028c965dd357272e3385001962`. Both final ranges pass `git diff --check`. Both have no tracked changes. Advisor has no untracked changes. Paws has only the pre-existing/generated Watchman cookies outside ignored scratch files; none was staged. Original main worktrees and MISS were not changed. No subagents were spawned. The progress ledger was not changed.

## Findings and contract

### I1: reliable admission certainty and capacity

`AIServiceClientError` now carries `submission`, default `uncertain`. The optional fourth constructor argument is `not-submitted`. A matching request ID is required before a transport can expose fresh refusal certainty.

The Paws start route emits a scoped `not-submitted` result only for typed `AIServiceError` admission failures. The transaction has failed or rolled back; unknown database/commit failures and malformed/network responses remain uncertain. The SDK does not infer certainty from a nonretryable code. Missing, malformed or mismatched markers do not prove non-admission. Requests cannot supply this result: request schemas remain strict. The trusted bridge serializes only SDK error metadata.

Both scoped and browser transports downgrade a refusal on a previously persisted outbox attempt to `uncertain`. The host adapter independently retains a previously persisted pending row even if a later SDK call reports nonretryable failure or a fresh-refusal marker. Original IDs, inputs and ciphertext are unchanged. A recorded rejection can be replayed locally without another provider call.

Fresh adapter validation/policy failures before reservation, including a second capacity check after an await, return proven local refusal. After reservation, only a typed, matching, fresh `not-submitted` error sets the row to failed. The conversation becomes interrupted; active capacity is released. The rejection and visible messages remain durable for audit/replay. Rejected user/assistant message rows are excluded from later provider context, so editing and resending does not silently include refused content. Cancel returns a local no-op without an upstream turn ID. Delete and another conversation become available.

Regressions use a permanent `model-unavailable` refusal, restart/retry/read/cancel, HTTP delete and a second conversation. The countercase keeps an uncertain row fenced across restart and even a later `not-submitted` error. Existing accepted/before-acceptance lost-response tests remain green.

### I2: editable local validation failure

The SDK exports its existing pure validator as `validateServiceMessages`. The advisor journal applies it to the full effective payload before writing a pending request. Personal history participates in the limit. A failed validation cannot reserve an immutable request or send HTTP. A small local error code supplies accurate safe copy: “请求内容过多或格式不受支持。请减少图片或文字后重试。”

For a proven matching refusal returned by start, the journal clears only that pending request. The UI derives busy state from the remaining pending journal entry. Draft text and attachments remain editable. Actual uncertain submission preserves exact content and ID, and controls stay fenced until recovery. No diagnostic text was added to the UI.

Installed-package tests cover three individually valid 1.9-million-character data URLs, cumulative personal history, corrected input, zero transport calls, scoped refusal and response loss. The controller also verified final UI behavior through Ego; see below.

### I3: concurrent completed result recovery

A start response for a running or terminal record triggers a read of its persisted encrypted snapshot. The SDK verifies/decrypts text and sequence instead of inventing an empty terminal answer. The shared-storage race test forces two POST paths to use the same ciphertext and returns a real encrypted final response. Both starts return the same text and sequence 7. The fixture counts one execution. Existing accepted-response-loss behavior still uses the original request/ciphertext.

### I4: native and probe errors

`nativeServiceErrors.ts` uses a small exact allowlist. Codex uses the locally generated 0.159.3 schema’s `TurnError.codexErrorInfo`; JSON-RPC method/parameter failures use numeric codes. Claude uses `SDKAssistantMessage.error` values. Known quota, login, model and protocol failures receive the appropriate public recovery category. Unknown errors stay `execution-interrupted`. Arbitrary messages, result.errors arrays, paths, tokens and guessed HTTP meanings are not scanned or exposed. Claude process exit no longer falsely implies login loss.

The code is used by Codex execution, Codex capability discovery and Claude execution. Execution binding aliases use exact internal strings instead of substring rules. Probe publish/read validates safe codes and preserves protocol and identity failures. Native child-process fixtures cover known and unknown failures; actual probe routes/store round-trip identity and protocol errors.

`final-native-error-fields.md` and `final-codex-turn-completed-schema.json` retain local schema evidence. These are structured-contract tests, not real provider acceptance.

### I5: complete migration inventory

The candidate and both rollout documents list all three added migrations in order. `scripts/verify-shared-ai-migrations.mjs` compares the candidate against `git diff --diff-filter=A f1fec57f212cf9ce8b4bd2788a3a955a3f93ea46`, then hashes every migration. It does not merely compare the manifest against itself. No database migration was executed.

### M1 and M2

The scope acknowledgement now passes `role="checkbox"`; its component regression asserts that role. A fresh complete Web export covers the final App source.

The smoke harness is formatted and core records are typed: Prisma client/database, installed SDK declarations, clients/receipts, capability catalog, worker claim/job, binding, messages, service and error code. It has no broad `any` state. Runtime SDK loading still resolves the installed public package. The actual HTTP routes, sealed envelope decryption, result publication, assertions and second-app bundle build remain in place. No fake SDK transport replaced them.

## Validation

Logs are preserved in `final-validation-logs/` beside this report. All checks below completed with exit 0 after the noted corrections.

| Command / location | Final result |
| --- | --- |
| P: `pnpm --filter @wangjs-jacky/paws-agent exec vitest run src/services` | 27 passed |
| P: `pnpm --filter @wangjs-jacky/paws-agent run build` | tsc/pkgroll passed |
| P: `pnpm --dir packages/happy-cli exec vitest run --project unit src/daemon/appDelegation/nativeServiceErrors.test.ts src/daemon/appDelegation/restrictedClaude.test.ts src/daemon/appDelegation/executionBinding.test.ts src/daemon/appDelegation/serviceCapabilities.test.ts` | 32 passed; CLI build/typecheck executed by test setup |
| P: `pnpm --dir packages/happy-server exec vitest run sources/app/aiServices/transport.spec.ts sources/app/aiServices/turns.spec.ts sources/app/aiServices/smokeAcceptance.spec.ts` | 13 passed, 1 serve-only skipped |
| P: rerun `smokeAcceptance.spec.ts` after installing final tarball | 5 passed, 1 serve-only skipped; scoped route refusal assertions included |
| P: `pnpm --dir packages/happy-server run typecheck` | Passed after final harness typing |
| P: `PATH="$PWD/.superpowers/sdd/2026-10-05-paws-shared-ai-service/toolchain/node_modules/.bin:$PATH" pnpm --dir packages/happy-server run build` | Passed; Bun bundled143modules |
| P: `pnpm --dir packages/happy-app exec vitest run sources/components/aiServices/ServiceEditor.test.tsx` | 2 passed |
| P: `CI=1 APP_ENV=production EXPO_PUBLIC_HAPPY_SERVER_URL=https://47.115.228.20:8443 pnpm --dir packages/happy-app exec expo export --platform web --clear --output-dir ../../.superpowers/sdd/2026-10-05-paws-shared-ai-service/final-web-export` | Full local export passed; no upload |
| A: `npm test` after refreshed installed package | 94 passed, 1 skipped |
| A: final `node --test test/ai-service.test.mjs` after copy/zero-transport regression | 41 passed |
| A: final `node --test test/paws-service.test.mjs` after stronger uncertainty/history assertions and capacity recheck | 20 passed |
| A: `npm run build` after final copy | Passed; committed `public/client.js` rebuilt |
| Both consumers: public services, services/browser, services/node ESM and CJS imports | Validator/error exports verified |
| Both consumers: all tar members compared with installed package files and lockfile SHA-512 | Exact match for SDK and panel |
| P: `node scripts/verify-shared-ai-migrations.mjs` | Three ordered migrations verified against review base |
| Both entire final fix ranges: `git diff <base>..HEAD --check` | Passed |

Meaningful new test names include: `trusts only a matching fresh refusal and keeps persisted response loss uncertain`; `decrypts the terminal duplicate POST in a shared-storage race with one execution`; `installed SDK rejects oversized platform/personal payload before journaling`; `installed browser transport is never reached for oversized journal input`; `journal clears only scoped proven refusal; response loss retains original ID and payload`; native sanitization fixtures; actual protocol/identity probe round trips; permanent-model-refusal restart/read/cancel/delete/capacity tests.

Corrections made during validation:

- Plain `npm install --force` kept cached bytes for the same file/version. This caused the first advisor run/build to lack the new export and certainty property. Explicit `npm install --ignore-scripts ./vendor/...paws-agent-0.3.0.tgz` refreshed each installed package and its lock integrity. The affected tests/builds then passed. The full installed-file comparison proves final bytes, not just the tar filenames.
- Initial smoke type imports traversed SDK source with a different tsconfig. They were replaced with built SDK declaration imports while preserving installed runtime imports. Explicit record types and request literals fixed the remaining type errors. Final server typecheck/build passed.
- One test-edit replacement produced `let assert.equal`; the syntax error was corrected before the final20-test adapter run.
- Watchman query timeout caused the existing Metro Node-crawler fallback. The final full export succeeded. Existing package exports/environment warnings, CLI pkgroll bin/empty-chunk warnings and advisor’s two high dependency-audit advisories remain visible. No dependency churn or clean-audit claim was made.
- No PostgreSQL concurrency suite rerun was needed: the fix does not alter lease/locking/schema implementation. Actual route/store tests use isolated PGlite. The controller-owned PostgreSQL service was left alone.

## Artifacts

SDK and panel versions remain unpublished0.3.0 and0.1.0. SDK was built and packed once for this fix, copied into both durable vendor directories, installed explicitly and verified byte-for-byte. Panel bytes remain unchanged and equal in both consumers.

| Artifact | SHA-256 |
| --- | --- |
| SDK191348bytes | `d3b126c9da01aeb0eef919fba47fc9a2cb561e035864b99d345104751e735f5a` |
| Panel17102bytes | `336608ab2da2c24fca13543df030421de932d3ae18a2b42adba9cde67b3954ce` |
| Advisor `public/client.js` | `c36f86acae6cc519da39275fd071768fd1239ab44d3458c856945bae51266687` |
| Advisor `public/paws-sdk.js` | `cc96e9fc9704b6f3a18d5dd1e47dfa8b62b1b9c33d626620d8f91126b9ec5f2d` |
| Advisor panel CSS | `1631c71d14abc20ead7dca965277a11961291cc44ed35cb9e587133099f016a8` |
| Final Web main bundle | `ddf34a462db923cdbe1d9b5d1a93a4791bc7fadea13f59d6413188b9b0da45bd` |
| Final Web file-manifest JSON | `eaa156e6c7dcb294ebe2ec617bc90dd931611c04513a2b64257402cb294efc90` |

Final Web export:1014files,60754700bytes. `final-web-export-files.json` lists every file. It is a local unstamped export of the final modified App code, not a deployed release. The durable candidate records it separately from the retained historical T11 export. No old hash is asserted to cover changed App code. Tarballs still lack tag/gitHead publication provenance.

Ordered migration hashes:

1. `20261005000000_ai_services`: `b426a821fc0dad6524915bc7e5451b82ab035f248859b78a77b061f87ca864a3`
2. `20261005010000_ai_service_execution`: `8902e820bdcf2d8c79ec81e59994f229fb3dffd425be5a80bae3386f42fce48d`
3. `20261006000000_ai_service_conversation_creation`: `b90158a45b09eff6baa4c99ea88832901e84e604725a8e957e42a362ed33dc70`

Durable evidence: Paws `docs/releases/shared-ai-services-candidate.json`, `docs/releases/shared-ai-services.md`, `docs/verification/shared-ai-services.md`; advisor `docs/verification/paws-services.md` and `paws-services-rollout.md`. Final documentation commits change evidence only; runtime artifact provenance points to the code/artifact commits above.

## Controller browser evidence and startup

Root supplied `final-browser.md`. Sanitized results are now in both durable acceptance documents and the candidate. Final advisor bundle, synthetic fixture,390×844: aggregate valid PNGs remain editable with accurate local copy and unchanged turn POST count1→1; removing attachments/retrying succeeds; `[reject-model]` releases capacity; `[lose]` fences input and recovers with one original POST and one matching user/answer pair. Reported Ego capture receipt suffixes: `kkiFJb`, `A26DKm`, `vbjDfP`, `LUUBmS`. The invalid post-initialization fetch observer was explicitly excluded; the final observer ran before SDK initialization. This agent did not operate a browser or independently inspect these frames.

Advisor startup, from A:

```sh
node scripts/advisor-service-fixture.mjs 4192 paws
```

Use `http://127.0.0.1:4192/`, invitation`000000`, public synthetic input only. `[reject-model]` triggers typed permanent-model refusal before storing a turn. `[lose]` stores a synthetic accepted result then loses the first response. `[slow]` permits cancel checks. Ctrl+C closes this fixture and deletes its temporary SQLite directory. Root currently owns fixture session40194 on4192; this agent left it untouched.

Second-app startup, from P/packages/happy-server:

```sh
PAWS_SMOKE_SERVE=1 pnpm exec vitest run sources/app/aiServices/smokeAcceptance.spec.ts --maxWorkers=1
```

It serves4193 after actual route/installed-SDK checks and keeps a synthetic worker alive. Ctrl+C ends the fixture. No fixture was started by this agent. All tests/build/export commands owned by this agent finished; no background process is left for the controller to clean up.

## Self-review and remaining limits

Reviewed the entire fix ranges and all changed interfaces. Exact bindings, target tuple, permissions, original request/ciphertext recovery, null-unless-observed actual values, server-side platform credentials and browser-only personal keys remain intact. Defaults, consent, legacy dispatch and existing source isolation were not broadened. Markers originate from trusted execution results, not browser input. Uncertain attempts are retained; nonretryable alone does not release them.

No production service call, deployment, migration, package publication, push/merge, login or account/default change was performed. Real provider success, exact real-account execution, real Claude acceptance, native-phone/real personal pairing and full legacy acceptance remain NOT EXECUTED. Owner daily-use acceptance is pending. Existing audit/environment warnings and tarball provenance limits remain. Production and rollout stay blocked even though these local findings are fixed.

## Evidence correction from implementer follow-up

SDK27 and CLI32 outputs were not saved under final-validation-logs. They existed only in implementer tool output from exec60859: SDK chunkbadd77 (6files27tests,05:23:09,2.55s); CLI chunk95deae (4files32tests,05:23:13,50.30s; capability5/nativeerrors6/Claude9/binding12). The blanket claim that all output logs are preserved is incorrect. Reviewer was informed; no blind rerun was requested.
