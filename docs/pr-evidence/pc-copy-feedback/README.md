# PC copy feedback evidence

Visible UI cases: 1

## Case COPY-FEEDBACK-01 — Copy reports success

- Problem: the paused-message Copy action wrote to the clipboard without any
  visible or assistive feedback, so clicking it appeared to do nothing.
- Before: `before.png` shows the icon-only action state. In the previous
  implementation this state remained unchanged after a successful copy.
- After: `after.png` shows the same message and layout immediately after the
  click, with a green checkmark and localized `Copied` label.

Both screenshots use the same authenticated local fixture, English locale,
light theme, `1280×720` viewport, and DPR `1`. The Playwright case also verifies
the clipboard value, the accessible success label, automatic reset to Copy,
cancelled editing, edited-send replacement, and persistence after reload.

Validation entry points:

- `pnpm test:e2e:web -- --grep 'PC 暂停后可复制并原位编辑最后一条输入'`
- `HAPPY_E2E_RECORD=1 pnpm test:e2e:web -- --grep 'PC 暂停后可复制并原位编辑最后一条输入'`
