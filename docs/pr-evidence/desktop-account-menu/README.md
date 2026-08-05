# Desktop account menu visual evidence

Case `PC-ACCOUNT-001` verifies that low-frequency account and system actions move
from the top of the work navigation to a persistent sidebar footer menu.

Both screenshots were captured by the authenticated-empty local Playwright
environment at a `1280 × 900` CSS viewport, device scale factor `1`, and browser
zoom `100%`.

- `pc-account-001-before-1280x900.png`: `origin/main` at `f9610820`; the account
  card and isolated settings action occupy the top of the work navigation.
- `pc-account-001-after-1280x900.png`: this branch; the footer trigger is visible,
  and its menu exposes profile, settings, account, support, and logout actions.

The same E2E Case also checks Escape dismissal, focus restoration, and the
narrow drawer entry. Those behavioral assertions are not inferred from these
static images.
