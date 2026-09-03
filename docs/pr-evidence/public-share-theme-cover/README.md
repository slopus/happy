# Public share theme and cover evidence

The primary set is exactly eight PNGs: four Before/After pairs. Cases 1–3 are 1440×900; Case 4 is a pair-matched 900×240 focus crop at the original CSS-pixel scale. The four `before` images come from verified pre-feature UI captures; the current raw `after` images were produced by `packages/happy-app/e2e/public-session-sharing-evidence.spec.ts` against this branch. Case-specific evidence processing is disclosed below. No screenshot contains a live credential or secret.

## Case matrix

| Case | Files | Viewport and state | Action | Expected | Actual |
| --- | --- | --- | --- | --- | --- |
| 1 — owner share dialog | `case-1-share-dialog-before.png` / `case-1-share-dialog-after.png` | 1440×900 primary capture; dialog also asserted at 1280×720, authenticated owner, dark app theme | Open Manage sharing after selecting Gingham, exercising a held/unavailable random request, uploading the repository PNG, publishing, and explicitly activating Copy link | Seven theme controls, unresolved replacement blocks publication, safe low-height dialog/internal scroll/focus return, usable fallback, decoded preview, accessible copy success | Before has only legacy sharing actions. After shows seven theme swatches, Gingham selected, decoded uploaded cover, copied public link, update/open/revoke actions. Browser assertions verify the busy/live state, disabled Create, background scroll lock, Escape/focus return, clipboard, and revoke cleanup. |
| 2 — anonymous covered share | `case-2-public-cover-before.png` / `case-2-public-cover-after.png` | 1440×900, anonymous, light mode, V2 Gingham snapshot; pair-matched blue focus annotation | Open the covered public ID after cross-ID/reload mode checks and activate its attribution | Compact read-only/noindex page, non-overlapping cover/header/transcript, immutable cover URL, canonical Pexels attribution, no owner chrome | Before truthfully shows the legacy coverless renderer; After shows a cover, attribution, compact header/mode toggles, and transcript. Browser assertions verify no auth/cookies, exact section geometry, `aria-pressed`, hover/focus/dismiss tooltips, immutable attachment URL, and the exact intercepted canonical Pexels destination without external navigation. |
| 3 — coverless public share | `case-3-no-cover-before.png` / `case-3-no-cover-after.png` | 1440×900 primary pair plus separate 390×844 supplemental current capture, anonymous, V2 Sage dark; pair-matched green focus annotation | Open a real-server V2 snapshot with no cover and resize to phone width | No reserved cover gap, non-overlapping header/transcript, viewport-edge vertical scroll owner, no horizontal overflow | Before is the truthful shared legacy anonymous source. After begins at the compact header with no banner gap; DOM geometry and hit tests prove the header does not cover the first transcript content and the scroll owner reaches both viewport edges at desktop and phone widths. A real-server V1 fallback is also asserted. |
| 4 — Gingham dark interaction | `case-4-gingham-dark-before.png` / `case-4-gingham-dark-after.png` | 900×240 pair at equal CSS-pixel scale, anonymous dark transcript/code-action focus | Keyboard-focus and activate Copy, then inspect success feedback | Theme-specific dark UI, mounted transcript and scroll position preserved during mode changes, keyboard-visible success feedback | Before is the distinct legacy anonymous Copy baseline. After is the matching current region with focused `Copied` feedback. Clipboard text, `aria-live`, reset timing, instance marker, and scroll offset are asserted in the full browser case. |

Cases 2 and 3 intentionally use the same raw pre-feature `anonymous-read-only-share-before.png` source (raw SHA-256 `64f0be67b79b9a7d2305898c9355dad09e6a81d85df30d7bbe2fa12e9a67e743`): the legacy renderer had neither an optional cover nor distinct coverless spacing. Both sides of Case 2 receive one deterministic blue 1440×900 focus overlay; both sides of Case 3 receive one deterministic green 1440×900 focus overlay. There is no resize, crop, generative edit, or UI reconstruction in those pairs. The annotations identify the case-specific comparison region and make the resulting Before files independently hashable.

Case 4 maps from the separately captured, truthful legacy anonymous Copy state at `docs/evidence/public-share-oss/share-ui-002-copy-before.png` (commit `b67c7a2a`, SHA-256 `ad756f7d745cc1381e17b517ecd66269c708cd5f8c28a62a88ddae7ef2573cc5`). Its After uses the 900×240 rectangle `(left=270, top=660)` from the 1440×900 current raw capture with no scaling, aligning the same centered code action. Case 1 maps from the legacy owner Manage sharing dialog and has no annotation or crop.

`supplemental/case-3-no-cover-390x844.png` is a current-state coverless phone-width capture. It is supplemental only and is not part of the eight primary PNGs.

## Reproduction

Verify the committed primary/supplemental artifacts byte-for-byte from the tracked raw inputs:

```bash
node scripts/build-public-share-theme-cover-evidence.mjs --verify
```

This command is strictly read-only. It generates all eight primary PNGs and the supplemental PNG under a fresh temporary directory, validates their names, dimensions, pair differences, and distinct Before hashes, then byte-compares them with the tracked artifacts and checks both sets against `evidence-manifest.json`. It never writes `raw/`, the tracked top-level artifacts, the supplemental artifact, or the manifest.

To refresh current raw browser captures, use the existing deterministic MP4 fixture and do not configure a Pexels key:

```bash
env -u PEXELS_API_KEY \
  HAPPY_E2E_MP4_PATH="$PWD/docs/evidence/public-share-oss/public-share-e2e-after.mp4" \
  HAPPY_PUBLIC_SHARE_EVIDENCE_DIR="$PWD/docs/pr-evidence/public-share-theme-cover" \
  pnpm test:e2e:web -- e2e/public-session-sharing-evidence.spec.ts

# Review raw/current first; then intentionally rebuild artifacts and refresh the manifest.
node scripts/build-public-share-theme-cover-evidence.mjs --refresh-manifest
node scripts/build-public-share-theme-cover-evidence.mjs --verify
```

The E2E command writes only under `raw/current/`; it cannot overwrite the reviewed primary artifacts. `--refresh-manifest` is the only evidence-builder mode that writes the processed primary/supplemental artifacts and manifest. It is reserved for an intentional, reviewed refresh because the owner flow contains a run-specific public ID and timestamp. Always follow it with the read-only `--verify` mode.

Focused verification and build commands:

```bash
node --test scripts/build-public-share-theme-cover-evidence.test.mjs
pnpm --filter @slopus/happy-wire exec vitest run src/publicSessionShare.test.ts
pnpm --filter happy-server-self-host exec vitest run \
  sources/app/sessionSharing/publicSessionCoverProvider.spec.ts \
  sources/app/sessionSharing/publicSessionShareStorage.spec.ts \
  sources/app/api/routes/publicSessionShareRoutes.spec.ts
pnpm --filter happy-app exec vitest run \
  sources/sync/publicSessionSnapshot.test.ts \
  sources/sync/publicSessionShareQueuePersistence.test.ts \
  sources/sync/apiPublicSessionShares.test.ts \
  sources/components/PublicSessionShareAppearanceControls.test.tsx \
  sources/components/PublicSessionShareDialog.test.tsx \
  sources/hooks/usePublicSessionAppearance.test.tsx \
  sources/components/PublicSessionTranscript.test.tsx \
  sources/components/markdown/CodeBlockCopyButton.test.tsx \
  sources/themePacks.test.ts
pnpm --filter @slopus/happy-wire run build
pnpm --filter happy-server-self-host typecheck
pnpm --filter happy-app typecheck
pnpm --filter happy-app export:web
```

## Artifact provenance

- Owner and compatibility flows use the ephemeral local Happy server, its real draft/asset/publish/public/revoke routes, and a real encrypted session transcript. The upload is the tracked 1600×1000 `docs/assets/plugin-host-v2/marketplace-installed.png`; the conversation attachment is the tracked `docs/evidence/public-share-oss/public-share-e2e-after.mp4` (748335 bytes, SHA-256 `7c58439201e47735cfc196eda2e074ff2acff1c8c2cf59afd5ec025917c7dfb9`). The browser test compares both published attachment responses byte-for-byte with their tracked inputs.
- The Pexels renderer case intercepts only the public snapshot and immutable attachment responses. Its attribution metadata is deterministic, and its cover bytes are the same tracked repository PNG. The browser intercepts `window.open`, verifies the exact canonical HTTPS Pexels host/path and empty credentials/query/hash, and never contacts Pexels or any external image host.
- “Immutable” in this evidence means the cover URL and object key are generation-addressed. Production asset responses intentionally use `Cache-Control: no-store` so revocation is immediate; browser/CDN immutable caching remains disabled until a purge contract exists. The deterministic renderer does not inject a cache header.
- The owner random-cover request is deterministically intercepted with HTTP 503 to prove that upload and coverless publication remain available without live Pexels credentials.
- Tracked immutable inputs live under `raw/before/`: the Case 1 owner baseline, the truthful shared anonymous baseline for Cases 2/3, and the distinct Case 4 Copy baseline. Tracked full-size browser outputs live under `raw/current/`; the E2E never writes processed evidence paths. `scripts/build-public-share-theme-cover-evidence.mjs` is the single deterministic annotation/crop/copy implementation.
- Before captures came from verified pre-feature browser evidence: Cases 1–3 from the 1440×900 run and Case 4 from the separate 900×240 legacy Copy capture. Current raw After captures are outputs of the browser command above before the disclosed evidence-only annotations/crop. The command builds the branch CLI normally and removes the ephemeral server environment after each run. Browser-side test finalizers independently revoke all owner and compatibility fixtures, including when an assertion fails.
- The full final run reports 3/3 passed. Each case collects browser console errors, uncaught page errors, request failures, and HTTP responses at or above 400. The provider 503 is allowed exactly once for the expected server origin/method/path/status. The revoked-share 404 is allowed exactly once for the expected Web origin/method/path/status and only while the revoked page is loading. Only `net::ERR_ABORTED` image/media requests matching the case's exact app-asset, blob, or public-attachment prefixes are classified as lifecycle cancellation; every other failed request is fatal. The development log endpoint is replaced in-page with a deterministic 204 before application code starts.
- Browser checks also cover anonymous/no-cookie requests, `noindex,nofollow,noarchive`, read-only chrome, V1 fallback, V2 covered/coverless rendering, canonical Pexels attribution, valid `aria-pressed` mode toggles and existing tooltips on hover/focus, light/dark/system local storage across IDs and reloads, system media changes, cover/header/transcript non-overlap, real scroll geometry, transcript instance/scroll preservation, low-height overlay/background scroll, focus restoration, phone-width containment, and keyboard copy feedback.

## SHA-256 manifest

| Artifact | Dimensions | SHA-256 |
| --- | --- | --- |
| `case-1-share-dialog-before.png` | 1440×900 | `0aa2eb1abe0a12f7a326df7b3a106c153049f503a2ec3a679703f12ef0c62a35` |
| `case-1-share-dialog-after.png` | 1440×900 | `589fc533155e93d9667cd01c79e92e92ae5b78a291cd29e225d4a6ca1d4a3dc6` |
| `case-2-public-cover-before.png` | 1440×900 | `cdeb15e5a8f74c7448f58e0c975bebf40feba263a3d59ecf0b2800f698d26e92` |
| `case-2-public-cover-after.png` | 1440×900 | `71e4fb7a82e263d1119470f83059fa584dc8cde8af8e07b2c537825af329f564` |
| `case-3-no-cover-before.png` | 1440×900 | `6fd0a0dec8bc4587c1d2b389890904dfcb778645549f757901032ce0a6889d9f` |
| `case-3-no-cover-after.png` | 1440×900 | `0ad2ae2706096d1c9f2052cf9d81e851fe5164558d4c79a70d70cc234b71e0ff` |
| `case-4-gingham-dark-before.png` | 900×240 | `ad756f7d745cc1381e17b517ecd66269c708cd5f8c28a62a88ddae7ef2573cc5` |
| `case-4-gingham-dark-after.png` | 900×240 | `bc527850291c8e1003a4c7c7681bb8847dc5d054d16537d44dcd50212d2f5633` |
| `supplemental/case-3-no-cover-390x844.png` | 390×844 | `cc58230a8f9dc2bd8213e5253f2518bfc98203d788d2042842a6e80ac240eb07` |
