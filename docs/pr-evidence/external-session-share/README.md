# External session share evidence

Recorded from the isolated packed-CLI E2E on 2026-09-01 after rebasing on
`origin/main`.

## Acceptance flow

1. Install the exact `@wangjs-jacky/paws-share` npm tarball into an empty
   directory.
2. Inspect and publish Codex and Claude Code JSONL sessions with an image
   attachment.
3. Open both links as an anonymous browser and verify the shared Paws
   conversation renderer, source label, attachment, Agent work folding, and
   absence of side panels and composer.
4. Revoke the Codex link using only the locally stored management capability.
5. Verify both the public snapshot and its attachment return 404 and the page
   renders the unavailable state.

## Rerun

```bash
HAPPY_E2E_RECORD=1 HAPPY_E2E_WEB_NO_DEV=1 pnpm test:e2e:external-share
```

## Artifacts

- `external-session-sharing-e2e.mp4`: H.264, yuv420p, 1280x720, 25 fps,
  71.56 seconds, fast-start enabled.
- `codex-public-snapshot.png`: active Codex snapshot with attachment and Agent
  work expanded.
- `claude-code-public-snapshot.png`: active Claude Code snapshot rendered by
  the same transcript component.
- `revoked-public-snapshot.png`: anonymous unavailable state after revocation.

## SHA-256

- Video: `bacafc40274c3b7bc54a898d333a683e459a822679ddc40d55d7e989e66e73c5`
- Packed CLI tarball used by the E2E:
  `70bd7e290c2e0392688e636f429a1b624bd46f8b66ce7010fbeefb56f724527c`
