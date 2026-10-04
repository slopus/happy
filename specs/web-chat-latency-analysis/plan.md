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
