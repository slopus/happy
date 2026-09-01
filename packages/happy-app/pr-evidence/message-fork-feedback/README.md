# Message fork feedback - visual evidence

Visible UI cases: 3

- Viewport: `1280 x 720`, DPR 1, dark gingham theme.
- Before: detached hover geometry, no pending feedback, and an empty error dialog were replayed from base commit `08c6035c0f962ca88294a570d595d90e08244ee6`.
- After: the same Playwright scenario and fixture were run against this branch.

## Case 1: stable hover path

The response action row now remains inside the hovered message boundary, so moving continuously from the response text to the Fork button does not cross a dead area.

| Before | After |
| --- | --- |
| ![Before: response actions sit below the message hover boundary](./before/case-1-before.png) | ![After: response actions remain inside the message hover boundary](./after/case-1-after.png) |

## Case 2: immediate loading feedback

The old UI retained the normal fork icon while the request was pending. The fixed UI immediately replaces it with a spinner and disables that message's Fork button.

| Before | After |
| --- | --- |
| ![Before: fork action has no pending state](./before/case-2-before.png) | ![After: fork action shows a spinner while disabled](./after/case-2-after.png) |

## Case 3: readable blank-error fallback

When the server returns an empty error message, the dialog now explains that the session could not be forked instead of showing only an `Error` title.

| Before | After |
| --- | --- |
| ![Before: error dialog has no explanatory message](./before/case-3-before.png) | ![After: error dialog contains a specific fallback message](./after/case-3-after.png) |

Automated coverage: `pnpm test:e2e:web -- e2e/web-compose-home.spec.ts --grep MESSAGE-HOVER-ACTIONS --trace=off` passed against both the base commit and this branch in isolated local environments. The after run also verifies the complete pointer path, tooltip alignment, action hit targets, hover containment, pending accessibility state, RPC sequence, session spawn/navigation, and the blank-error fallback.

Primary acceptance: [34.60-second successful-fork MP4](./message-fork-feedback-acceptance.mp4), `1280 x 720`, H.264/yuv420p. It ends on the newly created session (`No messages yet / Created just now`) after the loading state and successful navigation.

Failure handling: [53.76-second negative-path MP4](./message-fork-feedback-failure-handling.mp4). This separate run first completes a successful fork, then deliberately injects a blank backend error to prove the readable fallback in Case 3. Mobile playback has not been independently confirmed.
