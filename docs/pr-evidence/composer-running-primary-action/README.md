# Running composer primary-action evidence

- Case ID: `PC-COMPOSER-ACTION-001`
- Visible UI cases: `1`
- Fixture: the existing `/dev/session-composer` route temporarily rendered two real `MessageComposer` instances with `showAbortButton`; the temporary fixture wiring was removed after capture
- States: running with an empty input, and running with a follow-up payload ready to send
- Viewport: `1280×900`, DPR `1`, browser zoom `100%`, dark color scheme, Chromium
- Before baseline: `b5086f4977b076f563e7be3b844a5386c1a32fc1`
- After behavior commit: `9442ca9ba099f1405836eb528f2cd3a45aa76bf9`

Each image contains the same two labeled states at the same viewport. The before image shows a detached stop action at the left while the send control remains at the right. The after image shows one right-aligned primary action: a square stop icon while empty and an arrow when a follow-up is present.
