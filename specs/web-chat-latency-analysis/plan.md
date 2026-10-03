# Increment plan

1. Baseline tests; extract status mapping without behavioral change; verify and commit separately — Done,47 tests before/after,ad4d1ea3.
2. Red API and turn-path duplicate-query tests; minimally pass with operation-scoped reporting data and fallback — Done; mutation deleting reuse rejected by exact query-count assertions.
3. Regression/type/lint/build; paired twenty-run real app-server preparation measurement with fixed MCP configuration; preserve all samples and limits — Done,219 tests,20 alternating pairs66.888146→32.966354ms; preliminary40 rows excluded after cleanup failure but retained with the final40 rows.
4. Commit behavioral increment and open a PR — Code/measurement ready. Release and ethan Web verification remain pending.

Implementation authorized by the user. Before treatment measurement, accept only query count2→1, matching bounded metadata and a paired preparation reduction exceeding max(10ms,2×baseline MAD); this is an exploratory threshold, not a statistical guarantee.
