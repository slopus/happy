# Session workspace image preview

Opening a JPG from a conversation's file tabs previously called the text reader,
which rejected the binary bytes before the existing media viewer could run.
Project archive bindings already returned media; the session reader now returns
original bytes and a SHA-256 baseline for JPG/JPEG, PNG, GIF, WebP and AVIF.

Image reads use the existing scoped RPC (including outside-root read-only links)
and a 10 MiB limit. Text keeps its 2 MiB limit, strict UTF-8 decoding and binary
guard. No CLI upgrade, permission expansion or file modification is required.

The existing media view, refresh and original-byte download are reused. Images
show Preview without a Code toggle, cannot be edited/saved as text, and retain
any cached text draft separately so it cannot overwrite the image.

## Verification

- Regression before the fix: 9 failures covering image reads, the text size
  limit applied to images, cached draft safety and image controls.
- File workspace suite: original bytes/MIME/hash, uppercase and Unicode paths,
  outside-root scope, image/text size bounds, directory fallback, stale drafts,
  save protection and preview controls.
- `pnpm --filter happy-app typecheck`.
- Required runtime contract: `sources/utils/otaRuntimeConfig.test.ts`.
- Formal browser acceptance uses the original conversation, directory and JPG;
  production rendering and original-byte download results are recorded in the
  local Release OPS report after deployment. Unit/component results alone do
  not prove production rendering.

PR Before/After screenshots were asked about separately and remain optional.
No user business files or conversation messages are changed by acceptance.
