# Direct desktop screenshot evidence

- `before.png`: the previous camera menu with desktop, browser-window, and gallery choices.
- `after.png`: the same desktop composer after the removal; one camera control remains and no chooser or gallery entry is rendered.
- Browser acceptance used an isolated `authenticated-empty` environment at a 1440 × 900 viewport with a real online Codex session.
- Verified after clicking the camera control: no source menu appeared, the screenshot RPC ran immediately, and the UI surfaced the host `screencapture` failure (`exit code 1`) through the existing localized error dialog. The isolated CLI process does not have macOS Screen Recording permission, so successful image-viewer rendering is covered by the SessionView integration test instead.
- Console/network delta for the interaction contained no runtime exception, log error, or failed network request.
