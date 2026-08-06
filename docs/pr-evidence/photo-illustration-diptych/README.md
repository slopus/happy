# Photo–Illustration Diptych gallery evidence

- Case ID: `PC-GALLERY-PHOTO-ILLUSTRATION-001`.
- Viewport: 1440 × 900, DPR 1, Chrome through the repository Web E2E harness.
- Before: `main` at `b5086f4977b076f563e7be3b844a5386c1a32fc1`; the GitHub Skills category has five cards and does not include Photo–Illustration Diptych.
- After: the feature branch; the GitHub Skills category has six cards, with Photo–Illustration Diptych available as the leading card.
- Both captures use the same isolated authenticated-empty PGlite/server/Expo Web environment and the same Playwright test. The test waits for all preview images to decode, checks their 4:3 natural and displayed ratio, and confirms each image fills its preview container before capture.
