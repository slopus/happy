## Summary

- await the paused-message clipboard write and show an immediate localized success state
- replace the copy glyph with a green checkmark and `Copied` label for 1.8 seconds, then restore the original action
- announce the success state through a polite accessibility live region
- extend the existing PC Web E2E to require clipboard content, visible feedback, and automatic reset

## Visual evidence

Visible UI cases: 1

| Case | Problem | Before | After |
| --- | --- | --- | --- |
| COPY-FEEDBACK-01 | Copying a paused user message succeeded silently, so clicking the icon appeared to do nothing. | ![Before: icon-only Copy action with no success feedback](https://raw.githubusercontent.com/wangjs-jacky/happy/76af49cedc820311697362ed43c987ac7363cebb/docs/pr-evidence/pc-copy-feedback/before.png) | ![After: green checkmark and Copied success feedback](https://raw.githubusercontent.com/wangjs-jacky/happy/76af49cedc820311697362ed43c987ac7363cebb/docs/pr-evidence/pc-copy-feedback/after.png) |

Both screenshots use the same authenticated local fixture, message content,
English locale, light theme, `1280×720` viewport, and DPR `1`. The previous
implementation remained in the Before state after a successful clipboard
write; the After state is captured immediately after clicking the same action.

## Validation

- [x] `pnpm --filter happy-app typecheck`
- [x] `pnpm --filter happy-app exec vitest run sources/-session/SessionView.agentSpace.test.tsx` — 15 passed
- [x] `pnpm test:e2e:web -- --grep 'PC 暂停后可复制并原位编辑最后一条输入'` — 1 passed on latest `main`
- [x] `HAPPY_E2E_RECORD=1 pnpm test:e2e:web -- --grep 'PC 暂停后可复制并原位编辑最后一条输入'` — 1 passed; H.264 evidence video validated and delivered
- [x] The declared visible Case count equals the number of unique before/after screenshot groups embedded above.
- [x] The screenshots use comparable viewport/DPR/scale evidence and immutable commit-SHA URLs.
- [ ] An independent reviewer checked the rendered PR body, not only local files or a chat report.
