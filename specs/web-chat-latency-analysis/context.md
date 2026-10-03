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
