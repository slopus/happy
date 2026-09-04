# Responsive three-column evidence

Visible UI cases: 2

## Provenance

- Exact before product base: `dbdd0d4f9ad5438a12aa025ad5ebcb6e55beed5a`
- Before and after used the same authenticated local fixture, Chromium, light theme, English locale, and device pixel ratio 1.
- Case 1 viewport: 390 × 844.
- Case 2 viewport: 1024 × 768.
- Both phases used the same `HAPPY_E2E_WEB_NO_DEV=1` harness. The environment runner starts Expo with `--no-dev --clear`, so evidence has neither Fast Refresh UI nor a stale `EXPO_PUBLIC_*` server port compiled from Metro cache.
- The harness requires the Expo Fast Refresh indicator to remain absent for at least 1 second, and rechecks the indicator, LogBox, console diagnostics, and bottom-left warning geometry after each screenshot.
- The exact baseline alone permits the complete known React Native Animated `useNativeDriver` console warning; after evidence has no warning exemption.
- The baseline worktree contained no product-source differences. Its uncommitted overlay was limited to this T08 Playwright specification and the no-dev/clear environment switch.

## Files

- `case-1-before.png` — narrow session before a dedicated right-panel entry exists.
- `case-1-after.png` — narrow session with the visible edge handle and open Capability Hub drawer.
- `case-2-before.png` — compact desktop before a measured right-side drawer is available.
- `case-2-after.png` — compact desktop with the header toggle and open Capability Hub drawer.

## Capture command

```bash
HAPPY_E2E_WEB_NO_DEV=1 \
HAPPY_RESPONSIVE_LAYOUT_EVIDENCE_PHASE=<before|after> \
HAPPY_RESPONSIVE_LAYOUT_EVIDENCE_DIR=<absolute-evidence-directory> \
pnpm test:e2e:web -- --grep 'T08-0[12]'
```
