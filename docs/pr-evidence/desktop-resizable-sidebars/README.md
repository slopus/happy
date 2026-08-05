# Desktop resizable sidebars acceptance evidence

Viewport: 1280 × 720

## PC-SIDEBAR-001 — left sessions sidebar

- Before: default width with the `⌘B` tooltip visible.
- After: the sidebar is wider after dragging its divider; the tooltip remains visible.
- Automated checks: drag resizing, `⌘B` collapse/restore, click collapse/restore, and persisted width after reload.

## PC-SIDEBAR-002 — right Capability Hub

- Before: default width with the `⌥⌘B` tooltip visible.
- After: the panel is wider after dragging its divider; the middle workspace remains at least 480 px wide.
- Automated checks: drag resizing, `⌥⌘B` collapse/restore, click collapse/restore, Zen-mode restoration, and persisted width after reload.

## Verification

```bash
pnpm --filter happy-app test
pnpm --filter happy-app typecheck
pnpm test:e2e:web -- --grep '桌面三栏工作区'
HAPPY_E2E_RECORD=1 pnpm test:e2e:web -- --grep '桌面三栏工作区'
```

The acceptance MP4 is deliberately generated outside the repository and is not part of Git history. Until the separate temporary Video-object delivery feature is implemented, this PR relies on the committed screenshot pairs plus the recorded Playwright assertions as its portable review evidence.
