# PC file preview layout visual evidence

Case `PC-FILE-001` verifies the desktop flow from the Capability Hub file list
into the file detail view.

Both screenshots were captured by the authenticated local Playwright
environment at a `1280 × 720` CSS viewport, device scale factor `1`, and browser
zoom `100%`.

- `pc-file-001-before-1280x720.png`: `origin/main` at `5b3ddf09`; the persistent
  navigation controls cover the file-viewer title and the file body is shifted
  away from the workspace's left content edge.
- `pc-file-001-after-1280x720.png`: this branch; the title starts after the
  persistent controls and the file body aligns with the workspace padding.

The E2E Case opens the Capability Hub, chooses Files, clicks the seeded file,
and asserts the resulting URL, rendered content, title/control separation, and
left-edge alignment.
