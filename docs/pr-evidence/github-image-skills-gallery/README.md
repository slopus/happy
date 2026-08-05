# GitHub image Skills gallery evidence

- Viewport: 1440 × 900, DPR 1, Chrome through the repository Web E2E harness.
- Before: baseline commit `b5ec84b5824a61762d4cbcfbceaa96b44e0c74c5`; Effect gallery has no GitHub Skills category.
- After: feature branch; GitHub Skills category is selected and shows five cards with decoded preview images.
- Both captures use an isolated authenticated-empty PGlite/server/Expo Web environment and the same Playwright test. The test waits for a visible decoded image (`naturalWidth > 0`) before capture.
