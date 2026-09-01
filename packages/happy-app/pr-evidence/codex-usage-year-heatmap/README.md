# Codex annual activity heatmap evidence

## Scope

- Base revision: `e8a09cc4c02dbd93a5a0dd1521ef965fd350b8a3`
- Browser: Playwright Chrome, isolated authenticated Happy environment
- Theme: dark Gingham
- Data: temporary encrypted Codex usage machine, deleted after each Case
- E2E spec: `packages/happy-app/e2e/codex-usage-settings-evidence.spec.ts`

## Case evidence

| Case | User-visible contract | Before | After |
| --- | --- | --- | --- |
| CU-YEAR-01 | Replace the 14-day strip with a 365-day calendar: seven rows, 53 week columns, month labels, and four discrete intensity levels. | `case-1-before.png` (1280×900) | `case-1-after.png` (1280×900) |
| CU-YEAR-03 | Keep day selection readable while preserving distinct selected and pressed surfaces. The pair uses the same 920×210 crop from the 1280×900 Case viewport. | `case-2-before.png` (920×210) | `case-2-after.png` (920×210) |
| CU-YEAR-02 | At 390×844, start at the latest dates, allow horizontal browsing to the oldest date, and keep date selection usable. | Base behavior is represented by the 14-day desktop capture; no comparable narrow-screen baseline was available. | `case-3-after.png` plus the mobile segment of `cu-year-acceptance.mp4` |

`cu-year-acceptance.mp4` is the trimmed recording of the same passing E2E Cases: desktop overview and interaction first, then narrow-screen latest-date and backward-browse behavior. `cu-year-contact-sheet.png` samples the full delivered duration for visual inspection.

## Verification

- Normal E2E run: 2/2 passed.
- Recording E2E run: 2/2 passed.
- MP4: H.264, `yuv420p`, 1280×720, 25 fps, 12.72 seconds, fast-start, no audio.
- MP4 full decode: passed with zero errors.
- MP4 SHA-256: `94aa0b6b1bba3d383a9db24aa07246a2847d8fd84281bdb5bc84ff675abc9f93`.
