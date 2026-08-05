# Agent group panel visual evidence

Baseline revision: `da92d233a00656b47f452e380248bfe8af6e67b2` (`origin/main` after the working-directory context change landed).

All screenshots use Chromium, `1280x900`, DPR `1`, the same authenticated local Web route shape (`/session/:id`), and the same deterministic session metadata fixture. The local environment is isolated and removed after every run.

Visible UI cases: 2

| Case | Problem | Before | After |
| --- | --- | --- | --- |
| AGP-01 | Online Agent metadata and editable next-turn settings appeared as one flat list, so read-only and editable rows were difficult to distinguish. | `case-1-before.png` | `case-1-after.png` |
| AGP-02 | Offline sessions hid retained permission context behind a generic offline row and did not explain that configuration remained available for later execution. | `case-2-before.png` | `case-2-after.png` |

## Fixture

- Agent: Codex
- Machine label: `Agent panel online` / `Agent panel offline`
- Address: `atlas-mac-mini.local`
- Working directory: `/workspace/atlas-dashboard`
- Models: `gpt-5.5`, `gpt-5.6-sol`
- Reasoning effort: `high`, `xhigh`
- Permission: `Needs confirmation`

AGP-01 also exercises both synchronization directions: changing the model in the header panel immediately updates the composer, then changing it in the composer immediately updates the reopened panel. AGP-02 deactivates the session through the local authenticated API and verifies that all retained values remain visible while every execution row loses its button role.

## Reproduce

```bash
HAPPY_AGENT_PANEL_EVIDENCE_DIR="$PWD/docs/pr-evidence/agent-group-panel" \
HAPPY_AGENT_PANEL_EVIDENCE_PHASE=after \
pnpm test:e2e:web -- agent-group-panel-evidence.spec.ts
```

The `before` PNGs were captured before product edits with the same spec's evidence-only assertions against the baseline revision. The `after` phase contains the stronger post-change behavior and accessibility assertions. Both phases therefore include the same working-directory selector introduced by the baseline revision.
