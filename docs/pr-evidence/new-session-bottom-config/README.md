# New session composer settings evidence

Case `NEW-SESSION-COMPOSER-SETTINGS` verifies that the editable new-session
settings move from the separate expanded panel into the composer footer.

- `before.png`: current production/base behavior with the settings panel
  expanded.
- `after.png`: feature behavior with machine, path, agent, worktree,
  permission, model, effort, and Fast controls in the composer footer.
- Both captures use a 2560 x 1199 CSS viewport, DPR 1, and the same new-session
  state. The base capture inherits the production dark theme; the isolated
  feature acceptance environment uses its default light theme.

The feature was also checked at 1440 x 900, 1280 x 720, and 1024 x 768,
including horizontal overflow, picker focus/Escape behavior, setting changes,
and the disabled-send state for a new worktree.
