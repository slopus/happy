# Fast Fork navigation evidence

- Case: `[MESSAGE-HOVER-ACTIONS] PC Agent 回复悬浮后直接从所属回合分叉`
- User-visible result: Fork navigates directly to the newly spawned session without waiting for an account-wide session refresh.
- Ordinary rerun: `1 passed (1.5m)`, click-to-route `3459ms`.
- Recording rerun: `1 passed (1.1m)`, click-to-route `2211ms`.
- Fixture boundary: both reruns include a deterministic `1200ms` provider-side fork delay.
- Before/After: the same 1280×720 Case at the same 6.5-second post-click checkpoint. A deterministic 3.5-second `/v1/sessions` response delay reproduces the broadcast/full-refresh queue: `origin/main` is still showing Fork Loading, while the fix has already navigated to the new session.
- Visual evidence: [`case-1-before.png`](./case-1-before.png) → [`case-1-after.png`](./case-1-after.png).
- Side effects: isolated local Server/Web/session data only; both environments were stopped and removed by the runner.
- Video: [`message-fork-fast-navigation-acceptance.mp4`](./message-fork-fast-navigation-acceptance.mp4)
- Media validation: H.264, `yuv420p`, 1280×720, 25fps, 18.44s; `ffprobe`, full decode, and full-duration contact-sheet review passed.

The source change is latency-only and does not alter layout, colors, or copy, but the waiting/navigation behavior is user-visible and is therefore declared as one visual interaction Case.
