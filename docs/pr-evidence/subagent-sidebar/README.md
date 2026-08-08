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

## Cases

| Case | Problem | Before | After |
| --- | --- | --- | --- |
| `SUBAGENT-INSPECTOR-001` | Desktop sub-agent activity had no path to its captured transcript. | [`desktop-before.png`](desktop-before.png) | [`desktop-after.png`](desktop-after.png) |
| `SUBAGENT-INSPECTOR-002` | Narrow screens could not inspect sub-agent activity without leaving the conversation. | [`mobile-before.png`](mobile-before.png) | [`mobile-after.png`](mobile-after.png) |

The desktop after state shows the selected Agent's visible text and tool operation in
the existing right workspace panel. The mobile after state shows the same inspector in
the existing right-swipe drawer. The automated case also verifies nested Agent switching,
hidden-reasoning exclusion, sibling/root transcript isolation, and restoration of the
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
