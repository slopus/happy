> 历史验证记录。文中的 W 和临时绝对路径指当时的验证目录。保留的输出见本目录下的日志文件夹。各阶段结论以该阶段提交为准。

# N1/N2 certainty remediation report

Date: 2026-10-06. Status: implementation, self-review, local validation and commits complete. Controller review pending. No publication, deployment, account changes, browser actions or native build occurred in this wave.

## Commits and scope

| Worktree | Fix base | Source/artifact commit | Final HEAD with evidence |
| --- | --- | --- | --- |
| Paws | `2f051d6747e9689146d35a82d72db0f112732316` | `00a426aaeb59cb70a12efd627646150fe141bea4` | `776172ba82677abae7cf67e2fbf3135c9b17fbfe` |
| Advisor | `3b1a2c1e315c39bec00ab03f91f6617e7473be58` | `c66c820a2a26a9450abc212928590181b7c5d683` | `ab19e0ebd243fbfbe9e1e37359b1023f2a14c233` |

N1 is addressed by an atomic immutable admission outcome shared by all transport instances. Both scoped transports (Node and personal) and browser-platform use it. New durable tests exercise both response orderings through separate transports and through the installed public SDK plus the real advisor journal. N2 is addressed by deriving the final SDK file count from its tarball and updating the release table and candidate manifest to 43. Both consumers contain the same final package and matching lock integrity.

## Exact certainty contract

Each new outbox stores a random creator attempt ID with the original request data. An absent read is not proof of ownership. The caller owns the outbox only if the atomic `putIfAbsent` result contains its current attempt ID.

The outcome key is the outbox key plus `:admission-outcome-v1`. It is immutable. Before any non-owner caller may POST, it must atomically insert or read `uncertain`. If it reads a valid saved `rejected` result, it returns that refusal without a POST. Only the creator may propose `rejected`, and only after a trusted SDK error carries a valid safe code, matching request ID and explicit `not-submitted` marker. Browser request input does not supply this proof. Missing or malformed transport markers remain uncertain.

The creator and every contender compete for the same outcome slot. If rejection wins, later contenders cannot POST. If uncertainty wins, no caller can report `not-submitted`, including a creator whose own call was refused while another call might have run. Successful or ambiguous POSTs retain the original request ID, input and ciphertext. A retry cannot treat its own fresh refusal as evidence that an earlier submission did not run. A storage failure cannot establish refusal certainty.

The protocol has no lease, expiry, automatic takeover or evidence reclamation. The outcome must remain while its outbox/request can retry. A crash leaves uncertainty. An old outbox without creator provenance is always conservative. A prior saved definitive refusal can be returned on retry without a new POST.

All clients that can submit the same binding ID/request ID must use the same durable ServiceStorage namespace. Its `putIfAbsent` must be atomic across every participating handle. Merely using the same SDK version is insufficient. Disconnected stores cannot coordinate and are outside this release contract. Supported deployment scopes are the host's single-service SQLite store, browser session storage within a tab, and remembered IndexedDB storage. Shared memory is used for isolated tests and does not promise restart recovery. Session `putIfAbsent` now rechecks and inserts without an intervening await. IndexedDB uses its existing transaction; the host uses SQLite atomic insert.

All pre-fix candidate clients must stop or reload before this SDK is enabled. Mixed old/new callers are unsupported. This feature remains unpublished and undeployed. The controller approved these boundaries. No global server rejection ledger was added.

## Preserved behavior and self-review

The reviewed diff adds no new payload fields sent to the provider and logs no private input or credentials. Stored admission data consists of the creator UUID or a safe outcome with request ID, code and retryable flag. Original encrypted outbox data is retained.

The advisor adapter still terminalizes an ordinary fresh proven refusal and releases local active capacity. Rejected turns do not enter later provider context. Uncertain rows and journal pending state remain recoverable. Local validation keeps the draft editable. Same-ID terminal reads still decrypt the stored result. This wave changes no advisor product source; it updates installed SDK artifacts, the generated client bundle, tests and evidence. The current advisor suite covers prior refusal/capacity, local validation and encrypted response recovery alongside the new race cases.

Self-review checked the owner and contender orderings, legacy outboxes, atomic adapter behavior, storage failure, installed ESM class identity, exact request/ciphertext preservation, artifact integrity, and candidate documentation. No additional concern was found within the supported coordination contract.

## Validation and retained logs

All paths below are relative to this report's directory. Output files are in `certainty-validation-logs/`. P denotes the Paws worktree and A denotes the advisor worktree above. These are completed executions, not proposed commands. No green suite was rerun solely for the final handoff.

| Directory and command | Result | Output file |
| --- | --- | --- |
| `node W/final-certainty-race-probe.mjs` before refresh | RED: 2 POSTs, 1 accepted, false `not-submitted` | `independent-probe-red.json` |
| A: `node --test test/submission-certainty.test.mjs` before refresh | RED: all 6 installed-SDK/journal races failed | `advisor-installed-race-red.log` |
| P: `pnpm --filter @wangjs-jacky/paws-agent exec vitest run src/services` | 43 passed | `sdk-services.log` |
| P: `pnpm --filter @wangjs-jacky/paws-agent exec vitest run src/services/submission.test.ts` | Final 17 passed; 16 overlap the previous run | `sdk-submission-final.log` |
| P: `pnpm --filter @wangjs-jacky/paws-agent run build` | tsc and pkgroll passed | `sdk-build.log` |
| P: `pnpm --dir packages/paws-agent pack --pack-destination ../../examples/ai-service-smoke/vendor` | Packed final SDK | `sdk-pack.log` |
| A: `npm install --ignore-scripts ./vendor/paws/wangjs-jacky-paws-agent-0.3.0.tgz` | Installed final package and updated lock | `advisor-install.log` |
| P/examples/ai-service-smoke: `npm install --ignore-scripts ./vendor/wangjs-jacky-paws-agent-0.3.0.tgz` | Installed final package and updated lock | `smoke-install.log` |
| `node W/final-certainty-race-probe.mjs` after refresh | GREEN: 2 POSTs, 1 accepted, both errors uncertain, original pending retained | `independent-probe-green.json` |
| A: `npm test` | 101 passed, 1 skipped, 0 failed | `advisor-tests.log` |
| A: `npm run build` | Final browser assets built | `advisor-build.log` |
| P: `pnpm --dir packages/happy-server exec vitest run sources/app/aiServices/smokeAcceptance.spec.ts` | 5 passed, 1 serve-only skipped; actual routes and both installed consumers; second-app bundle built | `packed-route-smoke.log` |
| P: `pnpm --dir packages/happy-server run typecheck` | Passed | `server-typecheck.log` |
| `node W/certainty-check-exports.mjs` | Both consumers' services, browser and Node exports passed in ESM and CJS | `public-exports.log` |
| `python3 W/certainty-artifact-check.py` | Every SDK/panel tar member matches both installs; both locks and archive copies match | `artifact-check.log` |
| P: `node scripts/verify-shared-ai-migrations.mjs` | All 3 added migrations and hashes match | `migration-inventory.log` |
| Final tar/manifest/release count assertion | SDK 43 matches tar members, manifest and release table | `release-file-count.log` |
| Both worktrees: `git diff FIX_BASE HEAD --check` and final status | Passed; tracked files clean | `final-status.log` |

The 17 final submission tests include atomic storage tests for shared memory, two session handles and two IndexedDB handles; both transport response orderings for Node, personal and platform; legacy outboxes; and outcome persistence failure. Six advisor regressions use public ESM exports and actual journals, including two handles to the same SQLite database. They retain the forced concurrent absent-read barrier. Assertions cover two POSTs with one execution, identical request body/ciphertext, uncertain errors and the original pending request in both journals.

The independent reviewer probe was run unchanged. It resolves a CJS entry through `createRequire`, whereas the advisor journal imports ESM. In the RED run here it exposed the false marker but retained pending because error class identity differed. This is not claimed as RED journal-clear evidence. The six new ESM regressions reproduce the journal defect and fail before the package refresh. They pass after the refresh.

The previous wave's SDK 27 and CLI 32 outputs existed only in tool transcripts. They were not persisted as log files. This report does not claim they were archived. Current-wave outputs listed above are retained.

## Final artifacts

| Artifact | Bytes | Regular files | SHA-256 |
| --- | --- | --- | --- |
| SDK 0.3.0 | 192311 | 43 | `184e901a14a7115b29ffd4f0707f768d2595d9daf9b6ae0047b81fa96ba10613` |
| Panel 0.1.0, unchanged | 17102 | 8 | `336608ab2da2c24fca13543df030421de932d3ae18a2b42adba9cde67b3954ce` |

Final advisor `public/client.js`: `66b169ffb6819a56c7a18cc8e410eb737951700c6972addc7564cb3301892022`.

The full tar-member hashes and static resource hashes are in P/docs/releases/shared-ai-services-candidate.json. The packages still use local candidate version metadata and contain no gitHead or release tag. They are not published provenance.

The unchanged App retains its previous export from code `a7557dc60f2c1d40f27a1ab00732e08c770cf1e8`: 1014 files, 60754700 bytes, main bundle SHA-256 `ddf34a462db923cdbe1d9b5d1a93a4791bc7fadea13f59d6413188b9b0da45bd`. App does not depend on this SDK. No App/native rebuild was needed. Earlier Ego screenshots and final-browser.md cover the earlier candidate's UI behavior. They are not evidence for this new admission protocol, and the browser was not reopened.

## Limits and handoff

Real-provider execution, native-phone acceptance, full personal/legacy acceptance and owner daily use remain NOT EXECUTED. Publication, deployment and wider rollout remain blocked. Existing SDK build warnings and the advisor's two high dependency audit findings remain outside this focused fix. Shared storage and old-client reload are required rollout conditions, not claims about arbitrary distributed clients.

No background service was created or left running by this wave. Existing Watchman cookie files were preserved and not staged. Controller-owned resources were left untouched. Independent review should compare only the two fix bases to the final HEADs above and use the retained logs and final artifacts.
