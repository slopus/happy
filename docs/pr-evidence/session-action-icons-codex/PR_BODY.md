## Summary

- replace the desktop session row's five-pointed star with a semantic Octicons pin
- expose the existing confirmed permanent-delete flow as a direct trash action
- keep pin, delete, archive, restore, and More controls in one consistent icon family
- lock the rendered icon names and delete tooltip into the Web E2E suite

## Visual evidence

Visible UI cases: 1

| Case | Problem | Before | After |
| --- | --- | --- | --- |
| NAV-16-01 | The pin action rendered as a star and the direct delete action was missing. | ![Before: star and archive actions](https://raw.githubusercontent.com/wangjs-jacky/happy/c41628d4ab97c39f7d76d134ff631670060a0fbc/docs/pr-evidence/session-action-icons-codex/session-actions-before-1280x900.png) | ![After: pin, delete, and archive actions](https://raw.githubusercontent.com/wangjs-jacky/happy/c41628d4ab97c39f7d76d134ff631670060a0fbc/docs/pr-evidence/session-action-icons-codex/session-actions-after-1280x900.png) |

## Validation

- [x] `pnpm --filter happy-app typecheck`
- [x] `pnpm test:e2e:web -- packages/happy-app/e2e/web-compose-home.spec.ts --grep 'NAV-13'` — 5 passed
- [x] The declared visible Case count equals the number of unique before/after screenshot groups embedded above.
- [x] Every visual Case uses comparable viewport/DPR/scale evidence and a stable image URL.
- [ ] An independent reviewer checked the rendered PR body, not only local files or a chat report.
