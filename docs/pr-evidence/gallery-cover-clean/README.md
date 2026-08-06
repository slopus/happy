# Gallery cover cleanup evidence

- Viewport: 1440 x 900 at DPR 1.
- Before: the gallery after PR #258, where the imported GitHub Skill covers still contained social-app chrome and embedded text.
- After: this branch, where all five covers are text-free 4:3 images that fill their preview containers. The top and bottom captures together show every cover completely.
- Capture path: the same GitHub Skills gallery flow in the isolated Web E2E environment. The test waits for all five images to decode and checks their natural ratio and rendered bounds before taking the top capture, then scrolls the gallery to capture the remaining row.
- Isolation: the E2E runner owns its temporary PGlite database, server, and Expo Web process and cleans them up after the run.
