# Public Share Theme and Cover Design

**Date:** 2026-09-03

**Status:** Approved

## Goal

Improve public session shares without introducing a second visual system: reuse every existing Paws theme pack, move the transcript scrollbar to the viewport edge, add an optional fixed cover sourced from Pexels or a user upload, and let anonymous visitors choose light, dark, or system appearance.

## Product constraints

- Public links remain readable without authentication.
- Existing Paws components and semantic Unistyles tokens remain the source of truth. No share-only theme palette or bespoke message styles are introduced.
- Each share stores its own theme pack and remembers the last share theme as the default for the next share.
- A cover is fixed per published generation. It changes only when the owner explicitly chooses another random image, uploads a replacement, removes it, and republishes.
- Visitor appearance changes only the light/dark mode. It never changes the theme pack fixed by the owner.
- Newly introduced cover bytes must be stored in OSS/S3 in production and never persisted to the application server filesystem.

## User experience

### Share dialog

The existing dialog gains two additive sections:

1. **Cover** — empty by default, with “Random image”, “Upload image”, and “Remove cover” actions. A random image comes from Pexels and remains a candidate until publication succeeds.
2. **Theme color** — the existing seven Paws theme packs (`caramel`, `gingham`, `terminal`, `acorn`, `sage`, `sakura`, `grape`) rendered with the same accent swatches used in Appearance settings.

Creating a new share initializes the picker from the device-local `lastPublicShareThemePack`. Opening an active share initializes it from that share’s snapshot. Selecting a share theme does not change the authenticated app theme.

Random-image loading, local image selection, cover import/upload, attachment upload, and final publication have explicit busy and failure states. A Pexels outage or missing API key disables only the random-image action; upload and coverless publication continue to work.

### Public page

- The root transcript scroller spans the complete viewport width. Message rows keep the current centered content width, so the browser scrollbar sits on the far-right edge without widening prose or code.
- A published cover appears above the compact header as a responsive landscape banner. No cover means no reserved blank area.
- The current chat-bubble mark is replaced by a restrained page/sparkles icon using existing semantic surfaces and icon libraries.
- A compact control at the upper-right offers light, dark, and system modes. The default is system; the visitor’s choice is stored locally and reused across public shares on that browser.
- The share’s theme pack remains fixed while the visitor changes modes.
- Pexels attribution appears unobtrusively on the cover and links to the original photo page.
- Existing code-copy feedback remains available: copy icon becomes a checkmark with translated success feedback and returns to idle after its current timeout.

## Snapshot contract

The wire contract becomes a discriminated V1/V2 union.

- V1 stays accepted and renders as caramel with no cover.
- New publications use V2.
- V2 preserves the V1 message/source/presentation structure and adds required `appearance.themePack` plus optional `appearance.cover`.
- `appearance.cover` stores an immutable share-asset ID, MIME type, byte size, dimensions, optional thumbhash, and optional Pexels attribution (`photoId`, photographer, photographer URL, photo URL).
- Invalid optional appearance metadata cannot make a historical V1 snapshot unreadable. Invalid persisted V2 snapshots continue to resolve through the existing unavailable-share path.

The active generation remains the unit of atomic publication. Cover assets live in the same generation namespace as message attachments and therefore participate in the existing manifest, quota, cleanup, revoke, and replacement rules. No Prisma migration or separate appearance table is introduced.

## Pexels integration

Pexels is the sole remote provider in version one.

- The server owns `PEXELS_API_KEY`; it is never sent to the app or browser.
- An authenticated random-cover endpoint verifies session ownership, fetches landscape photos from Pexels, normalizes the provider response, and returns only display-safe candidate metadata.
- Provider responses are cached for 24 hours. Random selection varies the candidate within the cached pool rather than calling Pexels on every click.
- Publishing sends the provider photo ID, never an arbitrary remote URL.
- The server re-fetches that ID from Pexels, allowlists Pexels image hosts, enforces response size/type limits, uses Sharp to produce a bounded landscape WebP/JPEG cover, and writes the resulting bytes into the pending share generation in OSS/S3.
- The import endpoint returns canonical cover metadata for insertion into the V2 snapshot.
- The provider download and OSS write occur outside database transactions. Database records are finalized only after the object exists.
- Attribution metadata is preserved in the snapshot even though image bytes are subsequently served from Paws storage.

## User-uploaded covers

- The existing image picker and normalization path accepts one image, rejects unsupported or oversized content, and produces display dimensions and optional thumbhash.
- The durable share job stores the normalized local URI and metadata, not image bytes in MMKV.
- The cover uses the existing authenticated draft asset preparation/upload flow and receives its own generated asset ID.
- If a resumed job can no longer read the local URI, publication fails without replacing the active generation and the UI asks the owner to select the image again.

## Theme application

- Snapshot `themePack` values reuse `THEME_PACK_IDS` and `resolveThemeName`; no theme colors are duplicated in the share feature.
- Public V1 snapshots resolve to `caramel`.
- Public visitor mode is stored separately from authenticated app settings under a public-share-specific browser key.
- The public route applies the resolved registered theme before rendering the ready transcript and subscribes to `prefers-color-scheme` only while mode is `system`.
- Every interactive surface uses `surface`, `surfacePressed`, `surfaceSelected`, or another existing semantic token. Non-default dark coverage must include `ginghamDark`.

## Reliability and security

- Random-cover requests and imports use authenticated owner rate limits.
- Pexels IDs are validated and re-resolved server-side; the server never fetches a caller-supplied URL.
- Remote and uploaded images are bounded by MIME, bytes, dimensions, and decode success. SVG and executable content are rejected.
- Failed Pexels calls, failed uploads, incomplete objects, expired drafts, and stale generations never replace the active public snapshot.
- Revoke and generation replacement clean cover assets through the same durable cleanup path as attachments.
- Public assets keep the existing noindex and public-share security headers. Although their object-storage keys are generation-addressed, responses deliberately remain `Cache-Control: no-store` so revoke takes effect immediately without a CDN purge contract. Immutable browser/CDN caching can only be enabled after purge support exists.

## Compatibility

- All published V1 links remain valid and unchanged.
- Old clients may continue publishing V1 snapshots.
- New clients publish V2 and can display both V1 and V2.
- A V2 snapshot without a cover uses the compact no-cover layout.
- A missing random provider configuration degrades to upload/no-cover rather than blocking sharing.

## Verification

- Wire tests prove V1 acceptance, V2 validation, theme-pack rejection, and cover-attribution privacy boundaries.
- Server tests prove owner authorization, Pexels response normalization, caching, domain/type/size validation, OSS persistence, manifest inclusion, and atomic failure behavior.
- App tests prove queue persistence, theme memory, Pexels and upload cover publication, V1 fallback, visitor-mode persistence, and public transcript structure.
- Browser E2E proves anonymous access, cover rendering, attribution, three-state mode switching, reload persistence, full-viewport scrollbar placement, copy feedback, and a historical V1 share.
- Visual evidence includes before/after screenshots for the share dialog, covered public page, no-cover public page, and a non-default dark theme. Independent code and PC interaction reviews examine the actual PR.

## Out of scope

- New theme packs or a custom theme editor.
- Full Pexels search, collections, or gallery browsing.
- Visitor control of the owner-selected theme pack.
- Per-view random covers.
- A separate mutable appearance table.
- The broader migration of every Web bundle/static deployment artifact to OSS/CDN. This feature still requires every newly created cover asset to be OSS/S3-only in production.
