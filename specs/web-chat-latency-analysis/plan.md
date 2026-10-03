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
