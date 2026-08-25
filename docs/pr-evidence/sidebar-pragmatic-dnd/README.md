# Sidebar pragmatic drag and drop evidence

Visible UI cases: 2

| Case ID | Problem | Before | After |
| --- | --- | --- | --- |
| SIDEBAR-DND-001 | Reordering a list highlighted the whole target row, so the final before/after position was ambiguous. | `list-reorder-before.png` | `list-reorder-after.png` |
| SIDEBAR-DND-002 | Moving a session used the same target treatment as list sorting and did not clearly communicate container assignment. | `session-target-before.png` | `session-target-after.png` |

All frames were captured by the same `[SIDEBAR-LISTS-TAGS]` Playwright case at 1440×900, DPR 1, using the Gingham dark theme. The baseline was captured from `origin/main@0b288780393febe3050e800616c2d22ed78a4257`; the after frames were captured from this branch before commit.

Reproduce with:

```bash
HAPPY_E2E_SKIP_CLI_BUILD=1 pnpm test:e2e:web -- --grep '\[SIDEBAR-LISTS-TAGS\]'
```
