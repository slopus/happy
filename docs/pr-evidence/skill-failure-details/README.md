# Skill failure diagnostics visual evidence

- Visible UI cases: `1`
- Fixture: a failed `Skill` tool call with a concise summary and a command-level diagnostic
- Viewport: `1280×720`, DPR `1`, Chromium, browser zoom `100%`
- Before baseline: `a7b007b8401e221f05dbbbefe847b449800146e8`
- After revision: the immutable feature-branch commit linked from PR #392

| Case ID | Problem | Before | After |
|---|---|---|---|
| `SKILL-FAILURE-DETAILS-01` | The old activity row showed only a generic failed state and discarded the diagnostic context. The revised row keeps the summary compact and exposes the bounded detail on demand. | [before.png](before.png) | [after-collapsed.png](after-collapsed.png), [after-expanded.png](after-expanded.png) |

The baseline capture temporarily injected the same failed `Skill` start/end
envelopes into the pre-feature revision. Its assertions prove that the old UI
showed the failed state but neither the summary nor detail and offered no button.
The temporary detached worktree was removed after capture.

## Verification

```bash
HAPPY_SKILL_FAILURE_EVIDENCE_DIR="$PWD/docs/pr-evidence/skill-failure-details" \
pnpm test:e2e:web -- packages/happy-app/e2e/skill-failure-details-evidence.spec.ts
```

The runner creates an isolated authenticated environment, starts the local
Server and Expo Web app, executes the Chromium case, and removes all temporary
state. It does not connect to production services or invoke a model.
