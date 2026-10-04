# Increment plan

1. Baseline tests; extract status mapping without behavioral change; verify and commit separately — Done,47 tests before/after,ad4d1ea3.
2. Red API and turn-path duplicate-query tests; minimally pass with operation-scoped reporting data and fallback — Done; mutation deleting reuse rejected by exact query-count assertions.
3. Regression/type/lint/build; paired twenty-run real app-server preparation measurement with fixed MCP configuration; preserve all samples and limits — Done,219 tests,20 alternating pairs66.888146→32.966354ms; preliminary40 rows excluded after cleanup failure but retained with the final40 rows.
4. Commit behavioral increment and open a PR — Done; #673 merged at22cd63701fc5b511744d549eb78c1bf6b3201620; exact-head CLI Smoke Test37114288296 succeeded.

## Release preparation

1. Prepare next version from merged main; registry latest/source/tag=.282, candidate=.283 — Done. No usage wire changes since .282; intervening changes are server-only.
2. Validate related Codex tests/build and prepared tarball install guard — Done;277 distinct related tests across9 files passed, CLI build/typecheck and local tarball install smoke passed. Version-bump PR is next.
3. After merged bump and explicit approval for exact matching tag push, use CI-only publisher and verify registry smoke — Pending.
4. Consume released vendor pointer and apply to ethan; independently confirm runtime metadata/terminal before Web20/A-B — Pending. Shared runtime is unchanged.

Implementation authorized by the user. Before treatment measurement, accept only query count2→1, matching bounded metadata and a paired preparation reduction exceeding max(10ms,2×baseline MAD); this is an exploratory threshold, not a statistical guarantee.

## Recovery cost decomposition — 2026-10-03

1. Add failing tests for separate initial inventory, resume, backoff and verification spans, diagnostic failure isolation and in-flight ownership.
2. Add optional operation-scoped measurement; preserve retries, authorization, inventory reuse and diagnostic-off behavior.
3. Accept bounded new stage names in Web; run scoped regression/type/build checks and open Ready PRs. No runtime or release change.

Parent recovery and child spans overlap; never sum them. This increment measures cost, not a speedup.

Implementation and parser regression checks complete. Runtime-loop baseline failures reproduced and preserved. Ready PR review is next, followed by companion Web deployment, CI-only CLI release with explicit exact-tag approval, and terminal-verified same-condition Web measurement.

## Recovery instrumentation release — 2026-10-04

1. Confirm merged #677/#4635, exact merged Happy CI and deployed Web parser — Done.
2. Prepare .285 on merged main; related195 tests/build/prepared install guard — Done.
3. Ready version PR; after merge request exact-tag approval, CI publish/registry verify — Pending.
4. Consume only released vendor and verify ethan runtime before collecting recovery substages — Pending.

## Selected runtime inventory — 2026-10-04
1. Exact0.160.0 upstream semantics.
2. Red scoped pagination/runtime precedence then minimal implementation.
3. Related tests/type/build and local20-pair A/B.
4. Record limits and Ready PR; no release/runtime update.

Steps1–3 Done: native semantics, Red/Green182 tests/build/typecheck, changed-file unused checks and20-pair real A/B. Step4 records ready; implementation PR next. External release and Web20 remain pending, no live speedup claim.

## Review compatibility fix
1. Red first/later-page ignored serverName response tests.
2. Finish that inventory pagination and skip remaining server queries; no persistent capability cache.
3. Regression/build and update existing Ready PR.

Compatibility steps1–3 Done: Red3, Green185, build/typecheck/unused0/diff checks, existing Ready PR update. Native older-version/Web latency remains unmeasured.

## .287 release preparation
1. Confirm #685 merge/CI and published .286; prepare next .287.
2. Related regressions/build and prepared artifact install guard.
3. Ready version PR; after merge present exact tag for approval.
4. CI-only publish then released vendor/ethan runtime and Web20. No unreleased runtime consumption.

.287 steps1–2 preparation/validation Done. Steps3–4 publish part superseded: .287 (tag 510b0b6c, PR #686, includes #685) was already published by CI; no .287 tag creation. Released vendor/ethan runtime and Web20 measurement pending.

## Initial inventory cost investigation
1. Exact0.160.0 startup/catalog await semantics.
2. Provider-free20 fresh-thread cold/warm pairs with4 local MCPs; retain per-server timing and initializer counts.
3. Validate raw outcomes, cleanup and distinguish fixture mechanism from real ethan root cause.
4. Record evidence; do not skip readiness or infer a safe optimization without measured duplicate work.

Investigation1–3 Done: exact native await semantics and fully verified20 cold/warm pairs. Step4 evidence recorded; next separate increment is privacy-bounded server-ordinal inventory timing, parser compatibility and actual cold measurements. No readiness bypass or speculative parallel implementation.

## Per-server inventory timing
1. Red full-pagination/diagnostic exception and single execution contracts.
2. Fixed repeated mcp-inventory-server spans; no identifiers, same32-span limit.
3. Web allowlist Red then scoped regressions/build.
4. Ready companion PRs; Web deploy before future released CLI; no runtime change.

Per-server timing steps1–3 Done: Red4+1, Green194+66, CLI build/typecheck and Web lint. Step4 Ready PR publication next; deployment/release/live measurement pending.

## .288 instrumentation release preparation
1. Confirm #693/#4670 merge and candidate registry/tag state — Done; merged CI/Web deploy pending.
2. Prepare .288 and run related regression/build/artifact install guard — In progress.
3. Ready version PR, merge/CI and exact release-tag approval — Pending.
4. Web deployed parser first, CI publish/registry verify, released vendor/ethan runtime and initial-request measurement — Pending.

.288 steps1–2 Done: merged Happy CI success, deployed Web212550c ready2/2, candidate214 tests/build/typecheck and prepared artifact fresh install smoke pass. Step3 Ready version PR next; exact tag approval/CI publish and runtime measurement remain pending.
