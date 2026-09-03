## Summary

- Replace the desktop tab switcher with a persistent icon rail, organization pane, session pane, chat, and Capability Hub while preserving historical entry points.
- Let the organization pane collapse from the session title and resize independently, with width and collapsed state persisted across reloads.
- Give Relationship Advisor its own compact conversation index before entering a streaming chat detail.
- Preserve the existing mobile staged drawer behavior and existing Paws theme tokens.

## Visual evidence

Visible UI cases: 2

| Case | Problem | Before | After |
| --- | --- | --- | --- |
| THREE-NAV-01 | Relationship Advisor opened directly into chat with no dedicated conversation index. | ![Before: advisor opens without its own index](https://raw.githubusercontent.com/wangjs-jacky/happy/d5a94dad44bce755028d675b4779fecb23f6711e/docs/pr-evidence/three-level-navigation/case-1-before.png) | ![After: dedicated advisor conversation index](https://raw.githubusercontent.com/wangjs-jacky/happy/d5a94dad44bce755028d675b4779fecb23f6711e/docs/pr-evidence/three-level-navigation/case-1-after.png) |
| THREE-NAV-02 | The organization pane had no title-side collapse control or independent resize behavior. | ![Before: fixed organization and session panes](https://raw.githubusercontent.com/wangjs-jacky/happy/d5a94dad44bce755028d675b4779fecb23f6711e/docs/pr-evidence/three-level-navigation/case-2-before.png) | ![After: resizable three-level navigation](https://raw.githubusercontent.com/wangjs-jacky/happy/d5a94dad44bce755028d675b4779fecb23f6711e/docs/pr-evidence/three-level-navigation/case-2-after.png) |

Visual evidence waiver: not requested

## E2E acceptance

| Case | Result | Spec / rerun | Mobile video | Report / Trace |
| --- | --- | --- | --- | --- |
| THREE-NAV-01 | Passed ordinary and recording modes | `[RELATIONSHIP-ADVISOR-HISTORY]` | [H.264 recording](https://raw.githubusercontent.com/wangjs-jacky/happy/d5a94dad44bce755028d675b4779fecb23f6711e/docs/pr-evidence/three-level-navigation/case-1-e2e.mp4) | Isolated local report; environment removed after run |
| THREE-NAV-02 | Passed ordinary and recording modes | `[THREE-LEVEL-NAV-PC]` | [H.264 recording](https://raw.githubusercontent.com/wangjs-jacky/happy/d5a94dad44bce755028d675b4779fecb23f6711e/docs/pr-evidence/three-level-navigation/case-2-e2e.mp4) | Isolated local report; environment removed after run |

- Environment and side effects: isolated Server/Web environments; no production account, daemon, or model call; runner removed every environment.
- Compact-width regression: `[THREE-LEVEL-NAV-COMPACT-WEB]` passed ordinary and recording modes at 800px with a persisted 320px organization width; the adaptive cap preserved a 200px session pane.
- Mobile playback: not yet confirmed on a separate mobile device.
- Visual comparability: all four screenshots use 1280×900, DPR 1, and Gingham dark; the two Before images were captured from `origin/main` with the same fixtures and theme.
- Known gaps: the desktop layout changes are PC/Web-specific; existing mobile staged drawer behavior is covered by component tests and the existing mobile E2E case.

## Validation

- [x] 83 targeted app tests passed.
- [x] `pnpm --filter happy-app typecheck` passed.
- [x] PC navigation, Relationship Advisor, and 800px persisted-width regression E2E passed in ordinary and recording modes.
- [x] Recorded MP4 files are H.264/yuv420p and passed `ffprobe`, full decode, and contact-sheet review.
- [x] The declared visible Case count equals the two unique before/after screenshot groups embedded above.
- [x] Every visual Case uses stable commit-SHA URLs.
- [x] Requested E2E videos use stable commit-SHA URLs and disclose mobile playback status.
- [ ] An independent reviewer checked the rendered PR body and code.
- [ ] Every CI check triggered for the current head passed.
- [ ] The exact merge message was shown to and approved by the maintainer.
- [ ] The merge does not bypass branch protection.
