# Desktop command search visual evidence

All captures use the isolated authenticated Web E2E environment with a
1280 x 900 CSS viewport, device scale factor 1, and browser zoom 100%.

- `pc-command-search-001-before-1280x900.png`: `origin/main` at `5b3ddf09`;
  Sidebar Search navigates away to the full session-management page.
- `pc-command-search-001-after-1280x900.png`: this branch; Sidebar Search opens
  the shared command palette in place, with executable Folder and Search Files
  actions plus recent cross-project sessions.
- `pc-command-search-002-before-1280x900.png`: `origin/main` at `5b3ddf09`;
  a path query shows only the session title and path in the management page.
- `pc-command-search-002-after-1280x900.png`: this branch; the same query shows
  highlighted matches, project, machine, Agent, relative time, and `Alt+1`.

The committed Playwright case recreates the two sample projects and verifies
focus, executable adjacent commands, metadata, highlighting, and that bare
numeric input remains searchable.
