# Final comprehensive regression acceptance

Visible UI cases: 0

This directory contains after-only acceptance artifacts for T10. The PR adds
tests and evidence only; it does not change runtime UI behavior, so these images
are not product before/after cases and do not count toward the visual-case gate.

## Provenance

- Exact product base: `9be11d1ff131813b7483de74b86bd85228f78342`.
- Chromium, English, light theme, device pixel ratio 1.
- Production-style Web evidence runtime: `--no-dev --clear`.
- The R10-05 gate rejects Fast Refresh UI, LogBox, unexpected console errors,
  horizontal overflow, unsettled drawers, overlapping columns, and unreachable
  right-panel controls.

## Artifacts

- `r10-05-390x844.png` — phone edge handle with the Capability Hub open.
- `r10-05-1024x768.png` — compact desktop drawer with the session main area retained.
- `r10-05-1440x900.png` — persistent three-column workspace.

## Capture command

```bash
HAPPY_E2E_WEB_NO_DEV=1 \
HAPPY_FINAL_REGRESSION_EVIDENCE_DIR=<absolute-evidence-directory> \
pnpm test:e2e:web -- --grep 'R10-05'
```
