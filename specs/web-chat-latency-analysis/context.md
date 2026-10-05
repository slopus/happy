# State

2026-10-03: Isolated worktree from Happy main8839d058; CLI source version1.1.10-aplus.282. Platform's current vendor remains .278 and ethan's measured daemon was .280; cohorts must not be merged. Dependencies installed within this worktree. Related test baseline running. Shared CLI/daemon/auth/config were not changed.

Implemented: structural status mapping extraction (`ad4d1ea3`) and optional operation-scoped `runtimeStatuses` from the final successful inspection. `runCodex` requests these statuses and uses them for immediate pre-turn publication. Default recovery callers retain the prior result shape. Next turn and manual status requests query again. Failed inventory, formatting or resume leaves no reusable snapshot and keeps fresh reporting fallback. Config failure precedence and recovery metadata overlay are unchanged.

Validation: baseline47 tests and post-extraction47 passed. New API tests first failed (8 failures); consumer reuse tests failed, and deliberately deleting reuse later produced two explicit query-count assertion failures. Restored implementation passes219 tests across recovery, real-client adapter, config synchronization, latency, turn-loop/shutdown and lesson wiring. Typecheck, changed-file scoped ESLint, benchmark ESLint, full CLI build and diff whitespace checks passed. The unit iteration config skips redundant builds only after a successful baseline build; final source also passed typecheck/build. Existing bundler notices about bin paths/empty chunks remained. `runCodex.channelClear` had four failures both with this change and after restoring original source; these are documented separately, not counted as successful checks or fixed here.

Real local preparation measurement: Darwin, Codex0.160.0, CLI source.282, fresh isolated empty Happy/Codex homes and one local stdio MCP publishing a tool. No credentials were copied and no model turn/provider inference was requested. After thread bootstrap, alternating A/B and B/A twenty pairs used the same native app-server/thread/config. Baseline uses the unchanged recovery+fresh-report API path; treatment requests final inspection metadata. No artificial RPC delay.

| Preparation-only measure | Baseline | Treatment |
|---|---:|---:|
| Attempts | 20 | 20 |
| Inventory calls | 40 | 20 |
| Median | 66.888146ms | 32.966354ms |
| Recovery failure / bounded-status mismatch / resumes | 0 / 0 / 0 | 0 / 0 / 0 |

Median reduction33.921792ms/50.714206%; paired reduction median33.996959ms exceeds preregistered max(10ms,2×baseline MAD)=12.659542ms. This is exploratory local preparation evidence, not ethan/Web/SDK-text/paint improvement or p95/non-regression proof. UI observation from ethan's different .280 runtime is not combined with these numbers.

A preliminary twenty-pair run also completed measurements (89.3350205→44.745625ms; queries40→20) but cleanup encountered a concurrent background Codex plugin checkout. Its forty raw rows remain in the platform result JSON as an excluded prior run; no provider failure is inferred. Scratch cleanup was confirmed separately, the benchmark's own scratch removal gained bounded retries, and a full rerun exited0 with cleanup confirmed. Eighty total preparation attempts are retained across both runs. The reproducible benchmark is `mcp-status-reuse-benchmark.mts`; original precision and bounded outcome/counts are in the platform's `codex-mcp-status-reuse-benchmark-20261003.json`.

Ready for code review. Release, vendor consumption and actual ethan Web same-condition terminal-verified20/A-B remain pending; shared CLI/daemon/auth/config were not changed.

## Release preparation — 2026-10-03

User reports #673 merged and asks to proceed. Saycode GitHub confirms merged22cd63701fc5b511744d549eb78c1bf6b3201620; exact implementation head28c4fa30 CLI Smoke Test37114288296 completed/success. Latest source, matching published tag and npm latest are1.1.10-aplus.282. Candidate1.1.10-aplus.283 is based on merged main; intervening #672 changes server diagnostics only, not CLI/wire. Version bump preparation is authorized; no release tag, registry mutation, vendor update or shared runtime change has occurred. Validation and version-bump PR are next.

Candidate validation: CLI build including typecheck passed with existing bin-path/empty-chunk notices. Related six Codex files219 tests plus release guard11/registry verifier9/companion installer38 tests (277 distinct tests across9 files) passed. First guard test attempt had7 cache EPERM failures; rerun with task-specific npm cache passed all11, without changing user cache ownership. No whole-suite success is claimed; the previously documented original-source channelClear failures remain outside this increment.

Prepared using prepare-publish-package.cjs, then npm pack --ignore-scripts from the prepared directory. Local tarball SHA256=d6e15f259f8be2affc8402a87cedb105fce7f90f33bf5643ca362e627f63e51b; size108769308 bytes. guard-publish-artifact.cjs --install-smoke exited0, checked12 bundled files and passed isolated fresh install, exact version, Saycode agent facade, production dependency closure, Fastify daemon preflight and daemon status. Lifecycle scripts were enabled for installation; companion tool installs were skipped by the guard. The guard removed its own isolated install prefix/home and did not start or update the shared daemon. The candidate tarball remains local; CI builds and guards its own artifact after the approved tag.

Release checkpoint: after version-bump PR is merged, create happy-cli-v1.1.10-aplus.283 on its merged main SHA and push only refs/tags/happy-cli-v1.1.10-aplus.283. That triggers Publish @buzzni/happy-cli (publishes .283 and moves latest). Explicit approval for this exact tag action is pending; no tag/registry/vendor/runtime change has occurred. Verify CI and exact-version registry installation before consumption.

## Recovery cost decomposition — 2026-10-03

Isolated latest-main branch based on33c688bb (.284), no vendor/shared daemon/runtime/release change. Added opt-in mcp-inventory, mcp-reconnect, mcp-backoff and mcp-verification spans. Recovery-owned single-execution guard isolates measurement exceptions and preserves authoritative operation results. Empty scope records no RPC; in-flight joiners do not receive duplicate child attribution. Existing recorder retains pending/resolved/rejected,32-span bound and diagnostic exception isolation.

Red: recovery stage/owner tests failed2 before implementation; Web new-stage tests failed4 before parser change. Green: recovery44 and latency14 tests passed, including overlapping37ms parent/inventory fake-clock result, default250ms backoff, exact RPC counts, failing/double observer and final inventory freshness. CLI typecheck/build passed (existing bin/empty chunk notices); Recovery/latency changed-file no-unused-vars scoped ESLint passed; runCodex has3 unchanged unused imports (Credentials/packageJson/trimIdent), independently reproduced on original main. Web configured ESLint passed. The final4-file related run passed184 tests. Web65 tests passed. Four runCodex tests timed out: shutdown2 and lessonProposal2; each reproduced after restoring the original main runCodex.ts. Full-suite success is not claimed.

Companion platform parser accepts the four fixed stages while retaining existing wire version/bounds/privacy stripping. Old Web parsers reject frames containing new names; deploy the companion parser before a future released instrumentation CLI. No speed improvement or actual ethan substage duration is claimed; those require merged/released/deployed runtime measurement.

## .285 release preparation — 2026-10-04

User reports merges and authorizes continuation. Saycode confirms #677 merged389b6c4b8142b590171ae2c76bf0ccc7e0b7b4a5 and #4635 mergedef4bddef4e8c9565ea6bb741976d1a4f1fb67547. Happy exact implementation and merged-main CLI Smoke runs37129284955/37160432541 completed success. Dev-shared Web deployment and both actual Pods run imageef4bdde and are ready (deployment2/2). This confirms rollout of the companion parser image before instrumentation CLI consumption.

Registry latest=.284; next candidate=.285 on merged main389b6c4b, matching .285 tag absent. Version-only package change; no new usage-wire fields. Candidate full CLI build/typecheck passed with existing bundler notices. Related4 files184 tests plus artifact guard11 tests passed (195 distinct). Previous runCodex4 timeouts and3 unused imports remain documented baseline limitations; full-suite/lint success is not claimed.

Prepared official publish package locally and ran guard-publish-artifact.cjs --install-smoke with task-specific npm cache: exit0,12 bundled files, fresh isolated lifecycle-enabled installation, exact .285 version, agent facade, dependency closure, daemon runtime preflight/status passed. Guard cleaned its own install prefix/home; no shared daemon/auth/config change. No local publish, release tag push, npm latest change, unreleased vendor pointer or actual ethan substage measurements.

Next: merge Ready version PR, then present the exact .285 tag creation/push on its merged SHA for explicit approval required by AGENTS.md; CI remains sole publisher. Verify registry smoke and consume only the released pointer/runtime before independent terminal-verified Web measurement.

## Selected thread runtime inventory — 2026-10-04

.285 ethan followups20 inventory median3187.261ms/recovery share99.982958% motivates this increment. Exact upstream rust-v0.160.0 commit a956835d020762cb2b570053af06f643a11c0ecc was inspected (app-server/src/request_processors/mcp_processor.rs, core/src/codex_thread.rs, codex-mcp/src/runtime/status.rs and codex-mcp/src/mcp/mod.rs). Unscoped inventory reloads config and constructs a fresh eager status-only McpConnectionSet. threadId+serverName refreshes dirty runtime then captures its published config/connections and computes selected-server auth. It reuses live connection/catalog, not a Happy cross-turn cache.

Recovery and manual expected-server reporting now pass the current expected names to selected paginated queries. Names deduplicate; empty scope emits0 RPC; each server has independent cursor cycle detection. Unspecified scope retains all-server API. N expected servers means N scoped RPCs instead of1 all-server RPC: fewer fresh connections, not fewer JSON-RPC calls. No timeout/concurrent turn/cache/permission changes. Old app-server status rejection retains existing startup-evidence/fresh-report fallback; performance on older versions is unverified.

Consume current runtimeStatus authenticationRequired/failed/cancelled/disabled/starting/notStarted before treating settled auth as connected. Recovery failures retain bounded resume/reinspection/cooldown; auth never triggers reconnect; starting remains informational reconnecting. Raw runtime fields are not added to outgoing metadata.

Red: scoped pagination and status-forwarding tests3 failed before implementation. Exact native enum/status precedence tests6 plus post-resume recovery test1 failed before runtime interpretation. Green: client117/recovery51/latency14 =182 tests passed. Vitest global setup CLI build/typecheck passed. Changed5 code/test files noUnusedLocals/noUnusedParameters diagnostic count0. Existing bin-path/empty-chunk build notices remain; no repository TypeScript ESLint configuration/parser was available, so no ESLint pass or full-suite pass claimed. diff whitespace check passed.

Real Codex0.160.0 provider-free isolated homes, same thread/local stdio MCP, alternating20 pairs: final all-server median32.0508745ms vs selected0.867354ms (97.293821% local reduction); paired delta median30.474729ms exceeds pre-fixed max(10ms,2*baselineMAD)=10ms.20 vs20 inventory calls, failure/statusMismatch/resume0. Initial exploratory20 pairs26.4483545→0.6787285ms are also preserved; final rows remain separate, not pooled. Both scratch cleanups confirmed. Script and both raw cohorts retained in mcp-selected-runtime-benchmark.mts/mcp-selected-runtime-results-20261004.json; JSON median statistics independently recalculated. No remote credentials copied, provider turn, shared daemon replacement or release. Local single-MCP preparation is not ethan/Web response improvement; multi-HTTP-server transport/auth cost and real Web20 remain pending after CI-only release.

Based on current Happy main ec5c8242 (.286); vendor/runtime/package version unchanged. Next: Ready implementation PR, merge and CI verification, then separately approved exact release tag workflow and ethan/Web remeasurement.

## Review: app-server ignores serverName — 2026-10-04

Accepted medium compatibility finding: if a scoped response includes another name, old app-servers can repeat full inventory for every expected server. Collect the current request separately, detect mismatch on any page, finish pagination and return that complete inventory immediately. Discard previously collected scoped entries rather than duplicating them. Remaining server requests are skipped. No persistent capability/version cache; a reconnect or future request retains independent scope detection. Cursor-cycle errors still reject rather than returning partial inventory.

Red3 verified first-page mismatch, later-page mismatch and mismatch after an earlier scoped request: old behavior repeated inventory and returned duplicates. Green client120/recovery51/latency14=185 tests passed; global setup CLI build/typecheck passed with unchanged bin/empty-chunk notices. Changed client/test noUnusedLocals/noUnusedParameters diagnostics0; diff whitespace passed. Three-server mock examples reduced3 full inventories to1 (three pagination requests), or2 requests when the first earlier response appeared scoped. These are deterministic RPC-count regressions, not real0.156.0 latency measurements. Prior local0.160.0 A/B remains its historical cohort. No release/shared runtime change. Existing Ready PR #685 updated with the fix.

## .287 release preparation — 2026-10-04

User reports #685 merged; Saycode confirms merged377043f183f151327e47c719263ed3c2db7a8bab, implementation head610387d3. CLI Smoke Test37179027572 for the merged SHA is still in_progress at the final check; no CI success claim. Published exact/latest .286, source version .286 and matching tag ec5c8242 verified. Candidate .287 registry lookup E404 and matching tag absent. New branch based on merged main377043f1; version-only package bump, feature release records appended. No usage wire change.

Candidate regression client123/recovery51/latency14=188 tests passed. Release artifact guard11/registry verifier9=20 tests passed in a separate run with task-specific npm cache (208 distinct tests across5 files). Both Vitest global setups built/typechecked the candidate successfully; unchanged bin-path/empty-chunk notices remain. No full-suite or ESLint claim. diff whitespace passed.

prepare-publish-package.cjs produced /tmp/happy-cli-287-prepared-20261004; guard-publish-artifact.cjs --install-smoke exited0, checked12 bundled files, fresh lifecycle-enabled installation and exact .287 runtime, bundled agent facade, production dependency closure, daemon preflight/status passed. Guard used isolated prefix/home and cleaned them; companion tool installation skipped by guard. No shared daemon/account/vendor change. No local publish, external tag or npm latest mutation. CI creates and validates its own release artifact after the approved tag.

Superseded: .287 was already published from PR #686 (merge 510b0b6c, which contains #685 377043f1). Registry exact/latest is 1.1.10-aplus.287 (2026-10-04T05:32Z), tag happy-cli-v1.1.10-aplus.287 points at 510b0b6c, and the Publish @buzzni/happy-cli run for 510b0b6c succeeded. The E404/tag-absent observations above predate that publish. This version PR (#687) changes no package/CI/lockfile content relative to 510b0b6c, so there is nothing new to release. Do not create or move the .287 tag; a further release, if needed, is .288 from current main. Released .287 vendor consumption in ethan, existing session preservation and same-condition Web first1+idle20 with independent durable completion verification remain pending.

## Initial inventory mechanism probe — 2026-10-04

#4665 merged b0ce64a1456f2cb4fba15139933f10d0bc8059a6 confirmed via Saycode. Exact Codex0.160.0 selected snapshot uses current published connections; list_available_server_infos awaits connection.client when no cached startup info, then list_tools_with_errors awaits tools. Happy starts thread then recovery sequentially. First inventory duration includes startup readiness;7s is not independently7s duplicate inventory work.

Provider-free real Codex0.160.0 isolated homes/cwd,20 fresh threads with4 local MCPs: synthetic initialize delays[0,400,400,400]ms. cold median447.369729ms vs warm5.295125ms; thread-start+cold median476.3613335ms. Per-server cold median[33.064937,404.1337085,2.904166,1.7018755]ms. warm initializer count0. Startup overlaps across servers; serial scoped queries did not sum three400ms delays in this fixture. No safe speedup inferred from converting requests to parallel. Raw outcomes verify connected and tools for every server,20 pairs, medians independently recalculated, cleanupConfirmed=true and diff check passed. Synthetic fixture mechanism is not ethan HTTP/auth root cause or a provider/Web A/B.

First attempt aborted before pair20 due local ENOSPC;19 earlier rows were not persisted and are not a complete latency cohort. Runner now writes each completed pair before continuing; only the final fully completed20-row cohort is used. Removed only this task's local .287 prepared package to free space. No shared daemon/provider/config or release changes.

Next implementation target: opt-in fixed bounded per-server inventory timing (ordinal only, no server IDs/config/error) to identify real startup contributor, with Web parser compatibility before release. Keep readiness/auth unchanged. This investigation does not resolve real7s root cause or claim a new speed improvement. No product runtime changes in this PR.

## Per-server inventory timing — 2026-10-04

Opt-in diagnostics now emit repeated fixed `mcp-inventory-server` spans for each scoped server's complete pagination. Array order is ordinal only; no server names, configuration, IDs or raw errors are exported. Parent inventory/recovery spans overlap these children and must not be summed. Wire version1,32 preparation spans and privacy filtering remain unchanged. Diagnostic-off requests omit the callback. Observer failure before/after execution, duplicate action invocation and swallowed operation errors preserve single execution and authoritative query results/errors. Pagination, scope-ignored old-server compatibility, sequential readiness/auth and recovery contracts are preserved.

Red: Happy observer regressions4 and Web allowlist1 failed before implementation. Green: Happy client128/recovery52/latency14=194 tests passed with CLI global build/typecheck; Web66 parser tests and configured changed-file ESLint passed. No full-suite or live speedup claim. Web uses runner config loader with existing ignored dependency symlink; shared dependency permissions unchanged.

Implementation complete; companion Ready PRs next. Deploy Web parser before future CI-only instrumentation CLI release, then verify ethan installed/running version and measure initial requests with independent durable completion. Package version/vendor/shared daemon unchanged; no release/tag/publish performed.

#691 merge65dc4114b3359c72d2c917797e03908a68fd7947 independently confirmed.

## .288 instrumentation release preparation — 2026-10-04

#693 merged8b7fa7346e386d061fed0a4569d318ff88ff2734 and #4670 merged212550c1c0b00e6c4ad171ebee15cdcaf0b9ebbc independently confirmed. Happy merged CLI Smoke Test37187092168 completed/success. Web Build and Push37187097280 completed/success, manifests commitf43cfdd pushed. Development web-ui image212550c desired/ready/updated2, observedGeneration=generation1265 verified. New parser is deployed before any instrumentation CLI release. No usage wire change.

Registry latest/source=.287; candidate exact .288 E404 and matching tag absent. Version-only .288 candidate based on merged main8b7fa734; no vendor/shared daemon/account changes. Related client128/recovery52/latency14=194 and registry verifier9 passed with CLI global build/typecheck. Artifact guard11 passed on rerun with task-specific npm cache: total214 distinct related tests across5 files. Initial guard7 failures were cache EPERM, not guard contract failures; shared cache permissions unchanged. Two initially overlapping build invocations were cancelled and discarded; final regression run was single build. Existing bin-path/empty-chunk notices unchanged. No full-suite/ESLint claim.

Prepared /tmp/happy-cli-288-prepared-20261004; artifact guard --install-smoke exit0, exact .288,12 bundled files and fresh lifecycle-enabled install with agent facade, dependency closure, daemon preflight/status verified. Guard isolated install/home and cleaned temporary resources. No local publish/tag/latest mutation. Ready version PR next; after merge and CI verify, exact happy-cli-v1.1.10-aplus.288 tag push requires release approval per docs/happy-cli-release.md. CI is sole publisher. Then released vendor/ethan install version + existing session preservation + independent durable initial-request measurements. No new speedup claim.

## .288 release scope review — 2026-10-04

Review confirmed competing .288 version PRs: #694 (Draft, scope lifecycle) and #696 (Ready, inventory instrumentation). Consolidate version publication in #696; #694 is superseded, not a .289 candidate. Its original Linux Claude warning is retained as a release acceptance constraint rather than silently waived.

The tested #696 head69ca5ab3 already contains #689/c9af5da1 (graceful daemon cleanup watchdog cancellation and fresh Claude state initialization), #690/871fc11f (unattended Agent Browser installation, digest-pinned released images and new release workflow), and #693 inventory timing. Its previous214 tests/build/install smoke are that candidate's validation, not full validation of later main changes.

Current main additionally contains #695/c602837a server stream write timing and newly merged #683/eac4a67a. #683 deliberately rejects Linux same-UID protected Claude launch when sandboxed Happy MCP is unreachable; it does not restore Linux Claude transport support. A release from main after #696 merge includes this fail-closed restriction. Therefore the review suggestion to omit the #683 hold cannot be applied as written. Before tag approval, validate the exact final release tree and explicitly disclose the unsupported Linux same-UID protected Claude path; do not describe it as a successful Linux Claude support release. #683 PR's reported validation is historical PR evidence, not rerun by this increment.

#690 adds the first future exercise of DOCKER_PAT-gated Docker Hub multi-arch image publication and abp-images.json generation before npm publish. The workflow was inspected: absent credentials warn and still publish CLI without the manifest, causing one-line install to refuse that release. No image publishing, credential availability, public pull or generated-manifest acceptance has been verified in this increment. Tag approval must cover image publication as well as npm latest; release acceptance must distinguish CLI registry smoke from image/manifest success. No secrets were read, no tag/publish/runtime changes.

#696 original-head CLI Smoke Test37187902232 all5 jobs passed. Documentation-only scope correction requires diff validation; previous candidate results are preserved with their exact scope.

## Off-turn Codex title — 2026-10-05

ethan .289 first requests (5/5) showed Codex spending three model requests per new chat: find the deferred change_title tool, call it, then answer (extra 4.2-7.4s after the first tool call; native exec 1 request/2.8s). Cause: `codexPrompt.ts` appends `CHANGE_TITLE_INSTRUCTION` while the session has no title. Evidence lives in aplus-dev-studio `specs/web-chat-latency-analysis` (#4732).

Change: `codexOffTurnTitle.ts` runs `codex exec --ephemeral -s read-only -c mcp_servers.<name>.enabled=false --output-schema` (one override per server from `codex mcp list --json`; `-c mcp_servers={}` is deep-merged and starts them anyway, and a name a dotted `-c` key cannot address fails the run) (session model, low effort, prompt on stdin, empty temp cwd, 45s timeout) in parallel with the first eligible turn and records the result through the existing locked `createChangeTitleHandler`. That turn omits the instruction. Eligibility: app-server auth source `cli-login`/`custom-home`, no wrapping sandbox, not run-once. Managed/multi-auth/unknown providers, sandboxed hosts and run-once automation keep the in-turn instruction. A failed, timed-out or unparseable run is logged (warn) and stops covering, so the next turn restores the instruction. A title that appears while running is never overwritten. Session shutdown cancels the run. `session` is resolved at call time because offline reconnection swaps it.

Verification: Red then Green, 23 module tests. Mutations removing the eligibility gate, the late-title guard or failure uncovering are each caught. CLI build exit0. Related files codexPrompt23/lessonProposal34/shutdown29/startHappyServer31 pass. runCodex.channelClear has 4 failures that reproduce identically on clean origin/main (pre-existing). Real local Codex0.160.0 smoke: valid Korean title + slug in 6.8s off the critical path. Not yet verified: isolated-daemon/Web end-to-end and the ethan A/B; no latency claim yet.

## Off-turn title — isolated daemon E2E and parity fix (2026-10-05)

An isolated install (`~/.happy-offturn-title-iso`, new machineId, dev server; shared daemons' pid/session counts unchanged before and after) showed the first gate excluded real hosts: this Mac and all 6 ethan sessions run with `Sandbox enabled`, and this Mac also uses the multi-auth proxy. The title exec now launches through `CodexAppServerClient.prepareSideCommand`: same multi-auth proxy account and env, same sandbox wrapper and seatbelt marker as the app-server. It is refused only for managed providers, mandatory sandboxes, or before connect, and run-once hosts stay excluded.

The first sandboxed run answered without the title round trips but the title exec exited 1. A temporary stderr capture in the isolated bundle only showed `Error loading config.toml: invalid transport in mcp_servers.cua_repl`. `codex mcp list` includes plugin/app servers that are not config tables, and `enabled=false` on them creates a transport-less server. Both commands now pass `-c features.plugins=false -c features.apps=false`, which leaves only config-defined servers to disable. A failed command now reports its first `Error` line with long token-like runs masked, in place of a bare exit code.

Isolated Web results, same Mac, Codex/gpt-6-luna/low, fixed OK prompt:
- Old gate: 3 model requests, Web first text 36.99s.
- New path: 1 model request, no title instruction in the prompt, tools 0. Web first text 3.26 / 3.51 / 3.13s, and the title was recorded off-turn after the fix.

These are descriptive n=1 vs n=3 numbers on a loaded shared Mac, not an A/B. Tests: module 35 and client 146 (6 new) pass, build exit0, and channelClear's 4 pre-existing failures are unchanged.

Self-review (2026-10-05): three crash/hang paths fixed, each Red first.
- A title exec ignoring SIGTERM hung the job in `running` forever, so the instruction was never restored. It now escalates to SIGKILL after the app-server's 2s grace, with the timer unref'd.
- An exec exiting before reading its prompt raised an unhandled stdin EPIPE that would kill the session process. A no-op stdin error handler now leaves reporting to the exit code.
- The never-awaited job promise could reject unhandled if recording the title threw. It now catches and marks the job failed.
- `OFF_TURN_TITLE_SCHEMA` is no longer exported.
Tests: module 38, related files unchanged, build exit0.
