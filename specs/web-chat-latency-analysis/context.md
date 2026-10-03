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
