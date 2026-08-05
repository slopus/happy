# Desktop resizable sidebars acceptance evidence

Viewport: 1280 × 720

## PC-SIDEBAR-001 — left sessions sidebar

- Before: clean `main` at commit `1085e97a`, which has neither drag resizing nor a shortcut tooltip.
- After: the sidebar is wider after dragging its divider; the tooltip remains visible.
- Automated checks: pointer and keyboard resizing, platform-correct shortcut presentation, `⌘B`/`Ctrl+B` collapse and restore, click collapse and restore, and persisted width after reload.

## PC-SIDEBAR-002 — right Capability Hub

- Before: clean `main` at commit `1085e97a`, with the left sidebar collapsed so the fixed-width right panel is isolated.
- After: the panel is wider after dragging its divider; the middle workspace remains at least 480 px wide.
- Automated checks: pointer and keyboard resizing, `⌥⌘B`/`Alt+Ctrl+B` collapse and restore, click collapse and restore, Zen-mode restoration, active-session coverage, 1920 × 1080 widths beyond the former 640 px cap, and persisted width after reload.

## Verification

```bash
pnpm --filter happy-app test
pnpm --filter happy-app typecheck
pnpm test:e2e:web -- --grep '桌面三栏工作区|超宽桌面侧栏|活跃会话页面'
HAPPY_E2E_RECORD=1 pnpm test:e2e:web -- --grep '桌面三栏工作区'
```

The acceptance MP4 is deliberately generated outside the repository and is not part of Git history. Until the separate temporary Video-object delivery feature is implemented, this PR relies on the committed screenshot pairs plus the recorded Playwright assertions as its portable review evidence.
