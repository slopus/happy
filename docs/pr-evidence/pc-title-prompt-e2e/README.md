# PC title-prompt evidence

Visible UI cases: 1

## Case PC-TITLE-PROMPT-01 — Renamed sessions keep the title prompt hidden

- Problem: the oldest PC user record was hidden only while its derived text
  matched the current session title. Renaming or regenerating the title made the
  duplicate title bubble appear again.
- Before: `case-1-before.png` shows the renamed header and the stale
  `优化批量图片生成体验` title prompt above the real follow-up message.
- After: `case-1-after.png` uses the same fixture and shows only the real
  follow-up message while preserving the renamed header.
- Fixture: isolated authenticated local Web E2E session with an original title
  prompt, a renamed session summary, and a later user message.
- Viewport: Chrome, light theme, `1496×768`, DPR `1`.

The Playwright case asserts the renamed header remains visible, the follow-up
message remains visible, and the original title prompt has no rendered node on
desktop. It then switches to `390×844` and verifies the title prompt remains
visible on narrow Web. A focused unit case also prevents filtering any loaded
message until the initial page is loaded and no older pages remain.
Recording mode also captures a 1280×720 browser video; the review copy is
encoded as H.264/yuv420p MP4 and fully decoded as part of evidence validation.

Validation entry points:

- `pnpm test:e2e:web -- --grep '\[PC-TITLE-PROMPT\]'`
- `HAPPY_E2E_RECORD=1 pnpm test:e2e:web -- --grep '\[PC-TITLE-PROMPT\]'`
