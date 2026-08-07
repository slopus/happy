# PC project hover actions evidence

- Visible UI cases: 1
- Viewport: 1280×900
- Device pixel ratio: 1
- Browser: Playwright Chrome
- Environment: isolated `authenticated-empty` local E2E environment

| Case | Before | After | Runtime assertions |
|---|---|---|---|
| PROJECT-HOVER-ACTIONS-01 — project row hover actions | `case-1-before.png` | `case-1-after.png` | Hover reveals `more-horizontal` and `edit-3`; More opens the existing session action popover; New session navigates to `/new`. |

Baseline:

```bash
HAPPY_PROJECT_HOVER_EVIDENCE_PHASE=before \
HAPPY_PROJECT_HOVER_EVIDENCE_DIR=<evidence-dir> \
pnpm test:e2e:web -- --grep '\[PROJECT-HOVER-ACTIONS\]'
```

After:

```bash
HAPPY_PROJECT_HOVER_EVIDENCE_PHASE=after \
HAPPY_PROJECT_HOVER_EVIDENCE_DIR=<evidence-dir> \
pnpm test:e2e:web -- --grep '\[PROJECT-HOVER-ACTIONS\]'
```
