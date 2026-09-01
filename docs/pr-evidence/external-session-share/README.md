# External session share evidence

Recorded from the isolated packed-CLI E2E on 2026-09-02 after the final
security review.

## Acceptance flow

1. Install the exact `@wangjs-jacky/paws-share` npm tarball into an empty
   directory.
2. Inspect and publish Codex and Claude Code JSONL sessions with an image
   attachment.
3. Open both links as an anonymous browser and verify the shared Paws
   conversation renderer, source label, attachment, Agent work folding, and
   absence of side panels and composer.
4. Inspect the Codex share with `status`, replace its snapshot through the
   local management capability, and verify that the original URL now renders
   the updated content.
5. Revoke the Codex link using only the locally stored management capability.
6. Verify both the public snapshot and its attachment return 404 and the page
   renders the unavailable state.

## Rerun

```bash
HAPPY_E2E_RECORD=1 pnpm exec tsx scripts/run-external-share-e2e.ts
```

## Artifacts

- `external-session-sharing-e2e.mp4`: H.264, yuv420p, 1280x720, 25 fps,
  47.92 seconds, fast-start enabled.
- `codex-public-snapshot.png`: active Codex snapshot with attachment and Agent
  work expanded.
- `codex-replaced-public-snapshot.png`: the same public URL after an in-place
  snapshot replacement.
- `claude-code-public-snapshot.png`: active Claude Code snapshot rendered by
  the same transcript component.
- `revoked-public-snapshot.png`: anonymous unavailable state after revocation.

## SHA-256

- Video: `9296381f3d78f25ec6706638409b03d19ddd7900b04f2142231a664792242a10`
- Packed CLI tarball used by the E2E:
  `4f2a1836aa01f631bab56169834a51ad6cec4a6edf300e59ba3c7b11c3afff15`
