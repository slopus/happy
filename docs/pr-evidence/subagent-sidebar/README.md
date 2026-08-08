# Sub-agent sidebar inspector evidence

Visible UI cases: 2

## Provenance

- Exact product baseline: `origin/main@0c5d1ba096452f128fe516a1e3d0058527bd7469`.
- Before and after use the same authenticated local fixture, Chromium, light theme,
  Chinese locale, and device pixel ratio 1.
- Case `SUBAGENT-INSPECTOR-001` uses a `1280 x 720` viewport.
- Case `SUBAGENT-INSPECTOR-002` uses a `390 x 844` viewport.
- The E2E environment starts isolated local Server, Web, and test daemon processes.
  It does not connect to production services or call a model, and the runner removes
  the temporary environment after the case.
- The deterministic fixture uses the real encrypted sync, reducer, transcript lookup,
  and product rendering path. It models a code-review Agent with an assignment,
  visible progress, Read/Grep/Bash operations, hidden reasoning, and a final finding;
  it is not evidence of a live model or live Agent invocation.

## Cases

| Case | Problem | Before | After |
| --- | --- | --- | --- |
| `SUBAGENT-INSPECTOR-001` | Desktop sub-agent activity had no path to its captured transcript. | [`desktop-before.png`](desktop-before.png) | [`desktop-after.png`](desktop-after.png) |
| `SUBAGENT-INSPECTOR-002` | Narrow screens had a protruding right-edge handle and could not inspect a sub-agent without leaving the conversation. | [`mobile-before.png`](mobile-before.png) | [`mobile-after.png`](mobile-after.png) |

Both after states select the nested `Review agent`, show its synchronized assignment,
visible progress, Read/Grep/Bash operations, and a structured P1 finding with file/line
context. The mobile after state uses the existing right-swipe drawer without rendering
the protruding edge handle. The automated case also verifies nested Agent switching,
hidden-reasoning exclusion, parent/root transcript isolation, and restoration of the
capability panel after Back.

## Capture command

```bash
HAPPY_SUBAGENT_INSPECTOR_EVIDENCE_DIR=<absolute-evidence-directory> \
pnpm test:e2e:web -- --grep '\[SUBAGENT-INSPECTOR\]'
```

## Validation checklist

- [x] The declared visible Case count equals the two unique before/after screenshot groups.
- [x] Every Case uses comparable fixture, viewport, DPR, locale, and scale evidence.
- [x] The corresponding ordinary and recording E2E runs passed.
- [ ] An independent reviewer checked the final rendered PR body and immutable image URLs.
