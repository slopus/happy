# Desktop panel bounds acceptance evidence

All screenshots use Chromium at browser zoom 100% and device scale factor 1.
The before captures come from clean `main` at `3fee0896`; the after captures
come from this branch after the desktop panel fix.

## PC-PANEL-001 — one divider line per panel boundary

Viewport: 1280 × 720.

- Before: the focused left resize boundary renders the browser focus outline
  in addition to the divider, producing two adjacent blue lines.
- After: the browser outline is suppressed and focus is represented by the
  resize handle's single central line. The sidebar and Capability Hub surfaces
  no longer add their own boundary borders.

## PC-PANEL-002 — bounded left and right panel widths

Viewport: 1920 × 1080.

- Before: dragging both panels consumes nearly the full viewport, leaving only
  the 480 px minimum center workspace.
- After: each desktop side panel stops at 480 px, leaving the center workspace
  substantially wider on an ultrawide display.

## Verification

```bash
pnpm --filter happy-app exec vitest run \
  sources/utils/desktopNavigationLayout.test.ts \
  sources/components/SidebarView.test.tsx \
  sources/-session/SessionView.agentSpace.test.tsx
pnpm --filter happy-app typecheck
pnpm test:e2e:web -- --grep '桌面三栏工作区支持独立折叠并保留禅模式前的偏好|超宽桌面左右侧栏保持各自最大宽度'
```
