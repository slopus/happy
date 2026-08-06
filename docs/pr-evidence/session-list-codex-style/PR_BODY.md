## Summary

- restyle desktop project/session navigation around the compact Codex sidebar hierarchy
- standardize session controls on Feather icons and a unified Web system-font stack
- reveal status, pin, and archive controls on hover/focus, marquee long titles, and render details in a non-blocking right-side portal
- preserve narrow/touch More-menu behavior and add geometry assertions that prevent the details card from covering later sidebar content

## Visual evidence

Visible UI cases: 1

| Case | Problem | Before | After |
| --- | --- | --- | --- |
| NAV-13-01 | The project/session rail mixed avatars, cards, status dots, and icon styles; a hovered final row could insert its details over the next project. | ![Before: card-based session navigation](https://raw.githubusercontent.com/wangjs-jacky/happy/<COMMIT_SHA>/docs/pr-evidence/session-list-codex-style/session-list-codex-style-before-1280x900.png) | ![After: compact Codex-style row with right-side details](https://raw.githubusercontent.com/wangjs-jacky/happy/<COMMIT_SHA>/docs/pr-evidence/session-list-codex-style/session-list-codex-style-after-1280x900.png) |

Both images use Chromium, English, light theme, DPR 1, and a 1280×900 viewport. The After case asserts that row actions remain inside the sidebar while the details card begins strictly beyond the sidebar's right edge.

## Validation

- [x] `pnpm --filter happy-app typecheck`
- [x] `pnpm --filter happy-app test --run sources/utils/sessionRowPresentation.test.ts sources/utils/sessionNavigationGroups.test.ts` — 10 tests passed
- [x] `pnpm test:e2e:web -- --grep '会话行组织可见回归'` — 5 tests passed
- [x] `pnpm test:e2e:web -- --grep 'NAV-13-01'` — final geometry and screenshot rerun passed
- [x] The declared visible Case count equals the number of unique before/after screenshot groups embedded above.
- [x] Every visual Case uses comparable viewport/DPR/scale evidence and a stable image URL.
- [ ] An independent reviewer checked the rendered PR body, not only local files or a chat report.
