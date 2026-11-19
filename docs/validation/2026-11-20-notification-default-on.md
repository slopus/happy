# Browser notification defaults and macOS presentation

## User request and evidence

Enable task completion notifications by default. The user also reports notifications becoming visible only after clicking. Their supplied screenshot shows an actual Paws task-completion notification in macOS Notification Center, so at least one completion notification reached the OS. It does not establish when the browser submitted it or whether macOS displayed a banner.

A clarification is pending to distinguish: notifications only visible after opening Notification Center; delivery delayed until switching back to Paws; or only test notifications arriving. No user OS settings or browser preferences have been changed, and no OS root cause is claimed.

## Change

- Default completion notifications to enabled when preferences are absent or malformed; preserve already-saved `false` preferences rather than silently overriding opt-outs. Prior versions persisted a boolean without provenance, so an existing stored false cannot be distinguished as an old default versus a deliberate choice and remains false.
- Display the app preference independently of browser permission. A missing/denied permission no longer makes an enabled preference look switched off; dismissing a permission prompt does not erase the enabled preference.
- Add an explicit, user-initiated authorization action when permission is pending. Never request permission automatically on mount.
- Explain macOS notification styles and Focus when browser permission is granted. Test submission wording distinguishes an API submission from visible OS delivery. A website cannot force a banner when system settings suppress it.
- No closed-page Web Push, polling, browser/system settings mutation, or changes to completion detection/delivery logic.

## Diagnosis boundary

Static review: the completion listener does not gate on visibility or focus and does not require a click to invoke `new Notification`. Web visibility/focus handlers report app-state to the server; they do not disconnect the socket merely because the page is hidden. This does not rule out browser tab suspension, disconnection, or user-specific OS presentation settings. Those remain dependent on clarification/real user-side evidence.

## Verification

- 69 tests passed: BrowserNotificationSettings (6), webCompletionNotifications (16), webSoundAlerts (11), localSettings (29), OTA runtime contract (7).
- Full happy-app TypeScript check passed; git diff --check passed.
- No real-browser/macOS banner acceptance claimed. Prior screenshot request is unanswered; no new browser/screenshot environment was created.
- Independent code review passed; reviewer independently reran 35 settings/preference tests and whitespace checks. Actual deployment results are recorded separately after completion.
