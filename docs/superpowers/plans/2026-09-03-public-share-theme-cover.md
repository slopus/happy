# Public Share Theme and Cover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add owner-selected existing Paws themes, fixed Pexels/uploaded covers, visitor light/dark/system switching, and a viewport-edge scrollbar to anonymous public session shares.

**Architecture:** Version the immutable public snapshot contract to V2 and store theme/cover metadata beside the existing message snapshot. Treat a cover as another generation-scoped share asset, using a server-side Pexels adapter for remote imports and the existing draft asset upload flow for local uploads; public rendering resolves only registered Paws themes.

**Tech Stack:** TypeScript, Zod, React Native/Expo Web, React Native Unistyles, Fastify, Prisma JSON, Sharp, MinIO/S3-compatible OSS, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-03-public-share-theme-cover-design.md`

## Global Constraints

- Public share routes remain anonymous and `noindex,nofollow,noarchive`.
- Reuse exactly the seven existing `ThemePackId` values and semantic theme tokens; introduce no share-only colors.
- V1 snapshots remain readable; new clients publish V2.
- Cover bytes never persist to the production server filesystem and must belong to the pending share generation before publication.
- Pexels is the only remote provider in version one; never fetch a client-supplied URL.
- All new user-visible strings are translated in every supported language.
- Use four-space indentation, pnpm, strict TypeScript, and test-first red/green cycles.

---

### Task 1: Version the wire snapshot and cover manifest contract

**Files:**
- Modify: `packages/happy-wire/src/publicSessionShare.ts`
- Modify: `packages/happy-wire/src/publicSessionShare.test.ts`
- Modify: `packages/happy-app/sources/sync/publicSessionShareTypes.ts`
- Modify: `packages/happy-server/sources/app/api/routes/publicSessionShareRoutes.ts`
- Modify: `packages/happy-server/sources/app/api/routes/publicSessionShareRoutes.spec.ts`

**Interfaces:**
- Produces `publicSessionThemePackSchema`, `PublicSessionCover`, `PublicSessionSnapshotV1`, `PublicSessionSnapshotV2`, and union `PublicSessionSnapshot`.
- Produces a manifest collector that includes message attachments and `appearance.cover.assetId`.

- [ ] **Step 1: Add failing wire tests for V1 compatibility and V2 appearance validation**

```ts
expect(publicSessionSnapshotSchema.parse(legacySnapshot).version).toBe(1);
expect(publicSessionSnapshotSchema.parse({
    ...legacySnapshot,
    version: 2,
    appearance: { themePack: 'sage' },
}).appearance.themePack).toBe('sage');
expect(() => publicSessionSnapshotSchema.parse({
    ...legacySnapshot,
    version: 2,
    appearance: { themePack: 'invented' },
})).toThrow();
```

- [ ] **Step 2: Run the wire test and verify RED**

Run: `pnpm --filter @slopus/happy-wire exec vitest run src/publicSessionShare.test.ts`

Expected: failure because version `2` and `appearance` are not accepted.

- [ ] **Step 3: Implement the discriminated V1/V2 schemas and exported types**

```ts
export const publicSessionThemePackSchema = z.enum([
    'caramel', 'gingham', 'terminal', 'acorn', 'sage', 'sakura', 'grape',
]);

export const publicSessionSnapshotSchema = z.discriminatedUnion('version', [
    publicSessionSnapshotV1Schema,
    publicSessionSnapshotV2Schema,
]);
```

The V2 cover object contains `assetId`, `mimeType`, `size`, `width`, `height`, optional `thumbhash`, and optional strict Pexels attribution. Keep URL lengths bounded and all objects strict.

- [ ] **Step 4: Add failing server tests proving a cover asset participates in manifest validation**

The test creates a V2 snapshot whose only asset is `appearance.cover.assetId`, uploads that asset, and expects publish success. A second test omits the uploaded object and expects `409 Shared attachment upload incomplete`.

- [ ] **Step 5: Run the route test and verify RED**

Run: `pnpm --filter happy-server-self-host exec vitest run sources/app/api/routes/publicSessionShareRoutes.spec.ts`

Expected: cover-only snapshot is rejected as a manifest mismatch.

- [ ] **Step 6: Extend manifest collection and metadata validation, then run GREEN**

Collect both message attachment descriptors and the optional cover descriptor. Require a cover asset to have `kind=image`, the same MIME/size as the snapshot, and a completed OSS object.

- [ ] **Step 7: Commit the contract change**

```bash
git add packages/happy-wire packages/happy-app/sources/sync/publicSessionShareTypes.ts packages/happy-server/sources/app/api/routes/publicSessionShareRoutes.ts packages/happy-server/sources/app/api/routes/publicSessionShareRoutes.spec.ts
git commit -m "feat(share): version public appearance snapshots"
```

### Task 2: Add the authenticated Pexels cover provider and OSS import

**Files:**
- Create: `packages/happy-server/sources/app/sessionSharing/publicSessionCoverProvider.ts`
- Create: `packages/happy-server/sources/app/sessionSharing/publicSessionCoverProvider.spec.ts`
- Modify: `packages/happy-server/sources/app/api/routes/publicSessionShareRoutes.ts`
- Modify: `packages/happy-server/sources/app/api/routes/publicSessionShareRoutes.spec.ts`
- Modify: `packages/happy-server/sources/app/sessionSharing/publicSessionShareStorage.ts`

**Interfaces:**
- Produces `getRandomPexelsCover(fetchImpl, apiKey, random): Promise<PublicSessionCoverCandidate>`.
- Produces `importPexelsCover(photoId, deps): Promise<ImportedPublicSessionCover>`.
- Adds authenticated `GET /v1/sessions/:sessionId/share/covers/random` and `POST /v1/sessions/:sessionId/share/drafts/:generation/covers/import`.

- [ ] **Step 1: Add failing provider tests**

Use complete literal Pexels fixtures. Prove landscape query/auth headers, normalized attribution, 24-hour cache reuse, missing-key behavior, rejected non-Pexels image hosts, non-image response rejection, and an oversized response abort.

- [ ] **Step 2: Run the provider tests and verify RED**

Run: `pnpm --filter happy-server-self-host exec vitest run sources/app/sessionSharing/publicSessionCoverProvider.spec.ts`

Expected: module is absent.

- [ ] **Step 3: Implement the provider boundary**

```ts
export interface PublicSessionCoverCandidate {
    provider: 'pexels';
    photoId: number;
    previewUrl: string;
    width: number;
    height: number;
    averageColor: string | null;
    attribution: {
        photographer: string;
        photographerUrl: string;
        photoUrl: string;
    };
}
```

Use the official `Authorization` header, a bounded in-memory cache keyed by query, and `sharp` to decode, autorotate, cover-resize to a maximum 2400×900 canvas, and emit WebP. The response URL is taken only from the re-fetched official photo object and must pass an explicit hostname allowlist.

- [ ] **Step 4: Add failing authenticated route tests**

Prove non-owners receive 404, missing configuration returns 503 without affecting other share routes, import writes an `image/webp` generation asset, retrying the same asset ID is idempotent or returns the existing canonical metadata, and failed provider/storage work leaves the draft unpublished.

- [ ] **Step 5: Run the route tests and verify RED**

Run: `pnpm --filter happy-server-self-host exec vitest run sources/app/api/routes/publicSessionShareRoutes.spec.ts`

- [ ] **Step 6: Implement routes and OSS persistence outside transactions**

Resolve ownership and draft validity first, fetch/transform outside the transaction, store through `putPublicShareAsset`, then create/finalize the generation asset with exact hash/size metadata. On a stale draft, remove the just-written object/generation and return `409`.

- [ ] **Step 7: Run provider, storage, and route tests GREEN and commit**

```bash
pnpm --filter happy-server-self-host exec vitest run \
  sources/app/sessionSharing/publicSessionCoverProvider.spec.ts \
  sources/app/sessionSharing/publicSessionShareStorage.spec.ts \
  sources/app/api/routes/publicSessionShareRoutes.spec.ts
git add packages/happy-server
git commit -m "feat(server): import Pexels share covers to OSS"
```

### Task 3: Carry appearance through the durable share publisher

**Files:**
- Modify: `packages/happy-app/sources/sync/apiPublicSessionShares.ts`
- Modify: `packages/happy-app/sources/sync/apiPublicSessionShares.test.ts`
- Modify: `packages/happy-app/sources/sync/publicSessionSnapshot.ts`
- Modify: `packages/happy-app/sources/sync/publicSessionSnapshot.test.ts`
- Modify: `packages/happy-app/sources/sync/publicSessionSharePublishing.ts`
- Modify: `packages/happy-app/sources/hooks/usePublicSessionShare.test.ts`
- Modify: `packages/happy-app/sources/sync/publicSessionShareQueue.ts`
- Modify: `packages/happy-app/sources/sync/publicSessionShareQueuePersistence.ts`
- Modify: `packages/happy-app/sources/sync/publicSessionShareQueuePersistence.test.ts`
- Modify: `packages/happy-app/sources/sync/publicSessionShareQueueRuntime.ts`

**Interfaces:**
- Queue input gains `themePack` and optional `coverSelection` discriminated as `pexels` or `upload`.
- API adds `getRandomPublicSessionCover` and `importPublicSessionPexelsCover`.
- `buildPublicSessionSnapshot` emits V2 with appearance.

- [ ] **Step 1: Add failing snapshot and queue-persistence tests**

Prove literal V2 output, cover selection round-trip through persisted queue JSON, historical records without appearance default to caramel/no cover, and malformed cover selections are dropped without crashing the entire queue.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `pnpm --filter happy-app exec vitest run sources/sync/publicSessionSnapshot.test.ts sources/sync/publicSessionShareQueuePersistence.test.ts`

- [ ] **Step 3: Add V2 builder and durable queue fields**

```ts
export type PublicSessionCoverSelection =
    | { kind: 'pexels'; photoId: number }
    | { kind: 'upload'; attachmentId: string; uri: string; name: string; mimeType: string; size: number; width: number; height: number; thumbhash?: string };
```

Persist metadata only. Keep existing queue records valid by defaulting `themePack` to `caramel` and `coverSelection` to undefined during parsing.

- [ ] **Step 4: Add failing publishing tests for Pexels and upload paths**

The Pexels case expects import after draft creation and cover metadata in the published snapshot. The upload case expects cover bytes to use prepare/upload and to count in progress. Both assert a failure occurs before `publishDraft` when cover preparation fails.

- [ ] **Step 5: Run publishing tests and verify RED**

Run: `pnpm --filter happy-app exec vitest run sources/hooks/usePublicSessionShare.test.ts sources/sync/apiPublicSessionShares.test.ts`

- [ ] **Step 6: Implement the API calls and publisher branches, then run GREEN**

Use `readFileBytes` for uploaded-cover URIs and the server’s canonical import response for Pexels metadata. Do not trust candidate URLs or attribution supplied by the client.

- [ ] **Step 7: Commit durable publication support**

```bash
git add packages/happy-app/sources/sync packages/happy-app/sources/hooks/usePublicSessionShare.test.ts
git commit -m "feat(app): publish themed share cover snapshots"
```

### Task 4: Add additive share-dialog appearance controls

**Files:**
- Create: `packages/happy-app/sources/components/PublicSessionShareAppearanceControls.tsx`
- Create: `packages/happy-app/sources/components/PublicSessionShareAppearanceControls.test.tsx`
- Modify: `packages/happy-app/sources/components/PublicSessionShareDialog.tsx`
- Modify: `packages/happy-app/sources/components/PublicSessionShareDialog.test.tsx`
- Modify: `packages/happy-app/sources/hooks/usePublicSessionShare.ts`
- Modify: `packages/happy-app/sources/sync/localSettings.ts`
- Modify: `packages/happy-app/sources/sync/localSettings.test.ts`
- Modify: `packages/happy-app/sources/text/_default.ts`
- Modify: `packages/happy-app/sources/text/translations/en.ts`
- Modify: `packages/happy-app/sources/text/translations/ru.ts`
- Modify: `packages/happy-app/sources/text/translations/pl.ts`
- Modify: `packages/happy-app/sources/text/translations/es.ts`
- Modify: `packages/happy-app/sources/text/translations/ca.ts`
- Modify: `packages/happy-app/sources/text/translations/it.ts`
- Modify: `packages/happy-app/sources/text/translations/pt.ts`
- Modify: `packages/happy-app/sources/text/translations/ja.ts`
- Modify: `packages/happy-app/sources/text/translations/zh-Hans.ts`
- Modify: `packages/happy-app/sources/text/translations/zh-Hant.ts`

**Interfaces:**
- Adds local setting `lastPublicShareThemePack`.
- `usePublicSessionShare.publish({ themePack, coverSelection })` enqueues the immutable choice.
- Controls use `ACCENTS`, `useImagePicker({ maxAttachments: 1, maxImageSizeBytes: ... })`, and server random-candidate API.

- [ ] **Step 1: Add failing local-setting and component tests**

Prove the default is caramel, all seven real accent IDs render, selection writes only `lastPublicShareThemePack`, random success shows attribution, missing-provider failure preserves upload/coverless actions, remove clears the candidate, and update of an active share starts from snapshot appearance rather than the last-used default.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `pnpm --filter happy-app exec vitest run sources/sync/localSettings.test.ts sources/components/PublicSessionShareAppearanceControls.test.tsx sources/components/PublicSessionShareDialog.test.tsx`

- [ ] **Step 3: Implement the focused controls using semantic tokens**

Do not duplicate theme values. Render swatches from `ACCENTS`; selected/pressed surfaces use theme tokens. Keep the existing dialog header, status, link management, revoke flow, and responsive width.

- [ ] **Step 4: Add all translated strings and re-read every translation object**

Add keys for cover, random, upload, remove, provider unavailable, theme color, light/dark/system, and attribution where needed. Keep source/provider names untranslated.

- [ ] **Step 5: Run component tests and typecheck GREEN**

Run: `pnpm --filter happy-app exec vitest run sources/components/PublicSessionShareAppearanceControls.test.tsx sources/components/PublicSessionShareDialog.test.tsx && pnpm --filter happy-app typecheck`

- [ ] **Step 6: Commit the dialog experience**

```bash
git add packages/happy-app/sources/components packages/happy-app/sources/hooks/usePublicSessionShare.ts packages/happy-app/sources/sync/localSettings* packages/happy-app/sources/text
git commit -m "feat(app): configure share themes and covers"
```

### Task 5: Render public covers, visitor mode, and viewport-wide scrolling

**Files:**
- Create: `packages/happy-app/sources/hooks/usePublicSessionAppearance.ts`
- Create: `packages/happy-app/sources/hooks/usePublicSessionAppearance.test.tsx`
- Modify: `packages/happy-app/sources/app/share/[publicId].tsx`
- Modify: `packages/happy-app/sources/components/PublicSessionTranscript.tsx`
- Modify: `packages/happy-app/sources/components/PublicSessionTranscript.test.tsx`
- Modify: `packages/happy-app/sources/components/ConversationTranscript.tsx`
- Modify: `packages/happy-app/sources/themePacks.test.ts`

**Interfaces:**
- `usePublicSessionAppearance(themePack)` returns `{ mode, setMode }` for `light | dark | system` and applies the registered Unistyles theme.
- `PublicSessionTranscript` renders an optional generation asset cover and keeps the virtualized list full-width while constraining row content.

- [ ] **Step 1: Add failing hook tests for visitor persistence and system changes**

Use literal localStorage fixtures. Prove default system behavior, light/dark persistence, reuse across public IDs, fixed owner pack, and media-query updates only in system mode.

- [ ] **Step 2: Run the hook test and verify RED**

Run: `pnpm --filter happy-app exec vitest run sources/hooks/usePublicSessionAppearance.test.tsx`

- [ ] **Step 3: Implement the visitor appearance hook with registered themes**

Resolve V1 to caramel. Call `UnistylesRuntime.setTheme(resolveThemeName(themePack, isDark))` and update root background through the resolved theme. Never copy palette hex values into the hook or public components.

- [ ] **Step 4: Add failing transcript structure tests**

Prove a cover uses `getPublicSessionAttachmentUrl`, Pexels attribution links to the snapshot URL, no-cover snapshots omit the banner, the page icon is the approved page/sparkles icon, the three-mode control is accessible, and `ConversationTranscript` is no longer inside the max-width frame that owns scrolling.

- [ ] **Step 5: Run transcript tests and verify RED**

Run: `pnpm --filter happy-app exec vitest run sources/components/PublicSessionTranscript.test.tsx sources/themePacks.test.ts`

- [ ] **Step 6: Implement the approved layout and full-width list**

Keep `ConversationTranscript` at viewport width. Move max-width/padding responsibility into the public transcript’s row/header wrappers or a supported row-container prop so virtualization and indicators remain correct. Verify ordinary Mermaid wheel behavior remains owned by the page.

- [ ] **Step 7: Run focused tests, typecheck, and commit**

```bash
pnpm --filter happy-app exec vitest run \
  sources/hooks/usePublicSessionAppearance.test.tsx \
  sources/components/PublicSessionTranscript.test.tsx \
  sources/components/markdown/CodeBlockCopyButton.test.tsx \
  sources/themePacks.test.ts
pnpm --filter happy-app typecheck
git add packages/happy-app
git commit -m "feat(web): render themed public share covers"
```

### Task 6: End-to-end verification and PR evidence

**Files:**
- Modify: `packages/happy-app/e2e/public-session-sharing-evidence.spec.ts`
- Create: `docs/pr-evidence/public-share-theme-cover/README.md`
- Create: `docs/pr-evidence/public-share-theme-cover/case-1-share-dialog-before.png`
- Create: `docs/pr-evidence/public-share-theme-cover/case-1-share-dialog-after.png`
- Create: `docs/pr-evidence/public-share-theme-cover/case-2-public-cover-before.png`
- Create: `docs/pr-evidence/public-share-theme-cover/case-2-public-cover-after.png`
- Create: `docs/pr-evidence/public-share-theme-cover/case-3-no-cover-before.png`
- Create: `docs/pr-evidence/public-share-theme-cover/case-3-no-cover-after.png`
- Create: `docs/pr-evidence/public-share-theme-cover/case-4-gingham-dark-before.png`
- Create: `docs/pr-evidence/public-share-theme-cover/case-4-gingham-dark-after.png`
- Modify: `.github/pull_request_template.md` only if the existing template cannot express the required cases; otherwise leave it unchanged

**Interfaces:**
- Produces reproducible E2E cases and PR evidence for the actual branch head.

- [ ] **Step 1: Run all focused suites**

```bash
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
```

- [ ] **Step 2: Run package typechecks and Web export**

```bash
pnpm --filter @slopus/happy-wire run build
pnpm --filter happy-server-self-host typecheck
pnpm --filter happy-app typecheck
pnpm --filter happy-app export:web
```

- [ ] **Step 3: Run browser E2E against representative V1 and V2 fixtures**

Verify anonymous access, covered and coverless layouts, Pexels attribution, light/dark/system persistence, full-right scrollbar, copy success feedback, and narrow/mobile layout. Capture separate before/after images for every visible case, including `ginghamDark` interactive states.

- [ ] **Step 4: Run independent code and PC interaction reviews**

Review the actual diff and actual rendered branch. Fix every blocking issue with a new failing regression test before production code changes.

- [ ] **Step 5: Re-run verification after review fixes and commit evidence**

```bash
git add .
git commit -m "test(share): verify public appearance experience"
git status --short
```

- [ ] **Step 6: Push the feature branch and create a PR to `main`**

The PR body declares the real `Visible UI cases: N`, includes a case-by-case Before/After matrix using immutable commit-SHA URLs, records focused tests/typechecks/Web export, and is opened once to verify every image renders.
