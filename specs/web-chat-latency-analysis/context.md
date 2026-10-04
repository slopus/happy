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
