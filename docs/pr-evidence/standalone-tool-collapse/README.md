# STANDALONE-TOOL-01 visual evidence

- Visible UI cases: `1`
- Fixture: completed Skill/sub-agent activity followed by one standalone Bash call
- Viewport: `1100×820`, DPR `1`, Chromium, browser zoom `100%`
- Before baseline: `b5086f4977b076f563e7be3b844a5386c1a32fc1`
- After revision: feature branch head; the PR body pins the immutable full commit SHA
- Capture source: `packages/happy-app/e2e/web-compose-home.spec.ts`, case `[STANDALONE-TOOL]`

| Case ID | Problem | Before | After |
|---|---|---|---|
| `STANDALONE-TOOL-01` | With tool grouping enabled, one Bash call outside the completed work group bypassed the existing compact group row and rendered as a larger standalone terminal line. | [case-1-before.png](case-1-before.png) | [case-1-after.png](case-1-after.png) |

The before and after images use the same normalized SessionEnvelope fixture,
message order, locale, viewport, DPR, theme, and full-page crop. The after Case
also asserts that the collapsed Bash header height stays within 2 px of the
visible Skill activity row. The grouping unit test separately proves that the
collapsed group retains the original tool message.

## Verification

```bash
HAPPY_STANDALONE_TOOL_EVIDENCE_PHASE=after \
pnpm test:e2e:web -- --grep '\[STANDALONE-TOOL\]'
```

The runner creates an isolated authenticated environment, starts the local
Server/Web/daemon, executes one Chromium Case, and removes all temporary state.
It does not connect to production services or invoke a model.
