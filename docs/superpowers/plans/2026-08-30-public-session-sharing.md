# Public Session Sharing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add one revocable, updateable public snapshot link per session, including all attachments, with a standalone read-only recipient page and no workspace or composer UI.

**Architecture:** The authenticated Web client loads and sanitizes the complete decrypted transcript, prepares generation-scoped public attachment uploads, uploads plaintext copies, then atomically publishes a versioned manifest. The server stores ownership and active-generation metadata in Postgres, keeps asset objects behind share-scoped opaque IDs, and exposes only two unauthenticated read routes. The Expo root layout detects `/share/:publicId` before auth restore and renders a minimal public route tree rather than `SidebarNavigator`.

**Tech Stack:** TypeScript, React Native Web, Expo Router, Unistyles, Fastify 5, Zod 4, Prisma/Postgres, MinIO/S3 or local file storage, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-30-public-session-sharing-design.md`

## Global Constraints

- One current share per source session; updating preserves its URL, revoking invalidates it permanently, and republishing rotates the public ID.
- Public IDs contain at least 192 bits of cryptographically secure randomness.
- A public snapshot is display-only and excludes session IDs, machine/path metadata, permission/model state, credentials, encrypted refs, and callbacks.
- Creation and management are PC Web-only; public viewing is responsive on desktop and mobile.
- All supported attachment types are copied into the share generation, and publication is atomic.
- Public pages never mount the workspace sidebars, realtime sync, session operations, or composer.
- All user-visible copy uses `t(...)` and is added to every translation file.
- All visible colors use active Unistyles semantic theme tokens.
- Remove only the narrow-screen session header's redundant **New session** action; preserve navigation-drawer creation.
- Do not start a dev server, simulator, emulator, Tauri dev process, OTA publish, deployment, or real-device validation during implementation.

---

### Task 1: Persist share generations and storage objects

**Files:**
- Modify: `packages/happy-server/prisma/schema.prisma`
- Create: `packages/happy-server/prisma/migrations/20260830050000_add_public_session_shares/migration.sql`
- Modify: `packages/happy-server/sources/storage/files.ts`
- Create: `packages/happy-server/sources/app/sessionSharing/publicSessionShareStorage.ts`
- Test: `packages/happy-server/sources/app/sessionSharing/publicSessionShareStorage.spec.ts`

**Interfaces:**
- Produces Prisma models `PublicSessionShare` and `PublicSessionShareAsset`.
- Produces `putPublicShareAsset(path)`, `publicShareAssetExists(path)`, `getPublicShareDownloadSource(path)`, and `deletePublicShareGeneration(prefix)`.
- `PublicSessionShare.publicId` is a 32-byte base64url token, `sessionId` is unique, and `activeGeneration` is nullable.

- [ ] **Step 1: Write storage tests** covering private path containment, local/S3 server-proxied byte writes/reads, object existence, and generation-prefix deletion.
- [ ] **Step 2: Run the focused test and verify failure** with `pnpm --filter happy-server exec vitest run sources/app/sessionSharing/publicSessionShareStorage.spec.ts`.
- [ ] **Step 3: Add Prisma relations and migration** equivalent to:

```prisma
model PublicSessionShare {
    id               String                    @id @default(cuid())
    publicId         String                    @unique
    accountId        String
    account          Account                   @relation(fields: [accountId], references: [id])
    sessionId        String                    @unique
    session          Session                   @relation(fields: [sessionId], references: [id], onDelete: Cascade)
    snapshot         Json?
    activeGeneration String?
    publishedAt      DateTime?
    revokedAt        DateTime?
    createdAt        DateTime                  @default(now())
    updatedAt        DateTime                  @updatedAt
    assets           PublicSessionShareAsset[]
}

model PublicSessionShareAsset {
    id         String             @id
    shareId    String
    share      PublicSessionShare @relation(fields: [shareId], references: [id], onDelete: Cascade)
    generation String
    name       String
    mimeType   String
    kind       String
    size       Int
    storagePath String
    createdAt  DateTime           @default(now())
    @@unique([shareId, generation, id])
    @@index([shareId, generation])
}
```

- [ ] **Step 4: Implement storage adapters** with strict `private/session-shares/<shareId>/<generation>/<assetId>` paths and revocation-aware local/S3 server proxying without presigned public URLs.
- [ ] **Step 5: Generate Prisma client and run tests** with `pnpm --filter happy-server generate` followed by the focused Vitest command.
- [ ] **Step 6: Commit** with `git commit -m "feat(server): add public share persistence"`.

### Task 2: Add authenticated publication and unauthenticated read APIs

**Files:**
- Create: `packages/happy-server/sources/app/api/routes/publicSessionShareRoutes.ts`
- Create: `packages/happy-server/sources/app/api/routes/publicSessionShareRoutes.spec.ts`
- Create: `packages/happy-server/sources/app/sessionSharing/publicSessionShareSchemas.ts`
- Modify: `packages/happy-server/sources/app/api/api.ts`

**Interfaces:**
- Produces owner endpoints `GET /v1/sessions/:sessionId/share`, `POST .../share/drafts`, `POST .../drafts/:generation/assets`, `PUT .../drafts/:generation/assets/:assetId`, `PUT .../drafts/:generation/publish`, and `DELETE .../share`.
- Produces public endpoints `GET /v1/public/session-shares/:publicId` and `GET /v1/public/session-shares/:publicId/attachments/:assetId`.
- Snapshot schemas expose `PublicSessionSnapshotV1`, `PublicSessionMessageV1`, and `PublicSessionBlockV1` with text, thinking, tool, and attachment variants.

- [ ] **Step 1: Write failing Fastify injection tests** for owner authorization, one share row per session, new-ID rotation after revoke, draft invisibility, incomplete-asset rejection, atomic generation replacement, idempotent revoke, public read, generic 404, safe attachment headers, and `no-store`/`noindex` headers.
- [ ] **Step 2: Run the focused route suite and verify failure** with `pnpm --filter happy-server exec vitest run sources/app/api/routes/publicSessionShareRoutes.spec.ts`.
- [ ] **Step 3: Define strict Zod contracts** where public message blocks are:

```ts
type PublicSessionBlockV1 =
    | { type: 'text'; markdown: string }
    | { type: 'thinking'; markdown: string }
    | { type: 'tool'; name: string; status: 'running' | 'completed' | 'failed'; title?: string; body?: string }
    | { type: 'attachment'; attachmentId: string; kind: 'image' | 'audio' | 'video' | 'file'; name: string; mimeType: string; size: number };
```

- [ ] **Step 4: Implement persisted, expiring draft creation and upload preparation** with cryptographic `publicId`, UUID generation IDs/assets, lifecycle versions, ownership checks, Serializable file-count/size/account/rate reservations, exact SHA-256 validation, and durable scheduled object cleanup.
- [ ] **Step 5: Implement publish transaction** that validates every manifest attachment against the same share/generation and atomically activates only an unrevoked matching lifecycle version without clearing a concurrent revoke.
- [ ] **Step 6: Implement revoke and public reads** with generic 404 responses, safe basename/MIME handling, and public security headers.
- [ ] **Step 7: Register the routes** in `api.ts` before the SPA fallback.
- [ ] **Step 8: Run route/storage tests and server typecheck** using `pnpm --filter happy-server exec vitest run sources/app/sessionSharing/publicSessionShareStorage.spec.ts sources/app/api/routes/publicSessionShareRoutes.spec.ts` and `pnpm --filter happy-server typecheck`.
- [ ] **Step 9: Commit** with `git commit -m "feat(server): expose revocable session shares"`.

### Task 3: Build and sanitize complete client snapshots

**Files:**
- Create: `packages/happy-app/sources/sync/publicSessionShareTypes.ts`
- Create: `packages/happy-app/sources/sync/publicSessionSnapshot.ts`
- Create: `packages/happy-app/sources/sync/publicSessionSnapshot.test.ts`

**Interfaces:**
- Produces `buildPublicSessionSnapshot({ title, messages, sharedAt }): { snapshot, attachments }`.
- Produces attachment jobs `{ sourceRef, encrypted, attachmentId, kind, name, mimeType, size }` without retaining the private ref inside `snapshot`.
- Consumes flattened `Message[]` from `storage.getState().sessionMessages[sessionId].messages`.

- [ ] **Step 1: Write failing sanitizer tests** for user/assistant/thinking text, public tool name/status envelopes, hidden-tool exclusion, nested tool children, file-tool parsing, attachment de-duplication, display-text selection, and absence of raw tool bodies, refs, credentials, session/machine/path, permission, model, and callback fields in serialized output.
- [ ] **Step 2: Run and verify failure** with `pnpm --filter happy-app exec vitest run sources/sync/publicSessionSnapshot.test.ts`.
- [ ] **Step 3: Implement the contract and pure builder** using exhaustive switches over `Message.kind`; map file tool calls to attachment blocks and other tool calls to bounded plain-text summaries.
- [ ] **Step 4: Run the focused test and app typecheck for the new module** with the focused Vitest command and `pnpm --filter happy-app typecheck`.
- [ ] **Step 5: Commit** with `git commit -m "feat(app): build sanitized session snapshots"`.

### Task 4: Upload decrypted attachment copies and publish snapshots

**Files:**
- Create: `packages/happy-app/sources/sync/apiPublicSessionShares.ts`
- Create: `packages/happy-app/sources/sync/apiPublicSessionShares.test.ts`
- Create: `packages/happy-app/sources/hooks/usePublicSessionShare.ts`
- Create: `packages/happy-app/sources/hooks/usePublicSessionShare.test.ts`

**Interfaces:**
- Produces `getPublicSessionShare`, `createPublicSessionShareDraft`, `preparePublicSessionShareAsset`, `uploadPublicSessionShareAsset`, `publishPublicSessionShareDraft`, `revokePublicSessionShare`, and `getPublicSessionShareUrl`.
- Produces hook actions `share`, `update`, `revoke`, and state `{ share, phase, completedAssets, totalAssets }`.

- [ ] **Step 1: Write failing API tests** for Bearer auth, loopback URL rewriting, raw PUT upload, publish payload, public URL construction, and revoke.
- [ ] **Step 2: Write failing hook orchestration tests** proving it loads until `hasMoreOlder === false`, rejects on one failed attachment, never calls publish after failure, and publishes only after all asset uploads succeed.
- [ ] **Step 3: Run both suites and verify failure** with `pnpm --filter happy-app exec vitest run sources/sync/apiPublicSessionShares.test.ts sources/hooks/usePublicSessionShare.test.ts`.
- [ ] **Step 4: Implement share API calls** against `getServerUrl()` and reuse existing attachment download/decryption primitives. For encrypted files, call `downloadEncryptedAttachment` then `decryptBlob`; for plaintext media, fetch `requestAttachmentDownloadSource` directly.
- [ ] **Step 5: Implement the orchestration hook** using `useHappyAction`, `sync.ensureMessagesLoaded`, repeated `sync.loadOlderMessages`, the snapshot builder, sequential bounded-memory attachment copying, and final refresh of share state.
- [ ] **Step 6: Run both suites and app typecheck**.
- [ ] **Step 7: Commit** with `git commit -m "feat(app): publish public session snapshots"`.

### Task 5: Add PC share management UI and translations

**Files:**
- Create: `packages/happy-app/sources/components/PublicSessionShareDialog.tsx`
- Create: `packages/happy-app/sources/components/PublicSessionShareDialog.test.tsx`
- Modify: `packages/happy-app/sources/components/SessionInfoDropdown.tsx`
- Modify: `packages/happy-app/sources/components/SessionInfoDropdown.test.tsx`
- Modify: `packages/happy-app/sources/text/translations/{en,ru,pl,es,ca,it,pt,ja,zh-Hans,zh-Hant}.ts`

**Interfaces:**
- `SessionInfoDropdown` shows the row only when `Platform.OS === 'web'` and the responsive device is PC/tablet.
- `PublicSessionShareDialog` consumes `sessionId` and the hook from Task 4.

- [ ] **Step 1: Add failing component tests** for first-share confirmation, privacy warning, progress, success/copy/open, existing-share management, update, destructive revoke confirmation, and absence on narrow/native layouts.
- [ ] **Step 2: Run focused UI tests and verify failure** with `pnpm --filter happy-app exec vitest run sources/components/PublicSessionShareDialog.test.tsx sources/components/SessionInfoDropdown.test.tsx`.
- [ ] **Step 3: Add typed translations to every language** for share/manage/copy/open/update/revoke/privacy/progress/success/failure/not-found labels, preserving technical product terms where appropriate.
- [ ] **Step 4: Implement the dialog and dropdown row** using `Modal`, `useHappyAction`, `expo-clipboard`, Expo Router/open URL helpers, semantic surface tokens, accessibility labels, and stable test IDs.
- [ ] **Step 5: Run focused tests and app typecheck**.
- [ ] **Step 6: Commit** with `git commit -m "feat(web): add session share controls"`.

### Task 6: Render the standalone unauthenticated public page

**Files:**
- Create: `packages/happy-app/sources/app/share/_layout.tsx`
- Create: `packages/happy-app/sources/app/share/[publicId].tsx`
- Create: `packages/happy-app/sources/components/public-share/PublicSessionTranscript.tsx`
- Create: `packages/happy-app/sources/components/public-share/PublicSessionTranscript.test.tsx`
- Create: `packages/happy-app/sources/sync/fetchPublicSessionShare.ts`
- Create: `packages/happy-app/sources/sync/fetchPublicSessionShare.test.ts`
- Create: `packages/happy-app/sources/utils/publicShareRoute.ts`
- Create: `packages/happy-app/sources/utils/publicShareRoute.test.ts`
- Modify: `packages/happy-app/sources/app/_layout.tsx`

**Interfaces:**
- `isPublicSharePath(pathname): boolean` gates root initialization.
- Public root mode renders an Expo Router `Slot` inside theme/safe-area providers but does not read token storage, call `syncRestore`, mount `AuthProvider`, `SidebarNavigator`, realtime, command palette, OTA switcher, or image viewer.
- The public fetcher calls only `GET /v1/public/session-shares/:publicId` without Authorization.

- [ ] **Step 1: Write failing route/fetch tests** for path recognition, no Authorization header, response parsing, and generic not-found mapping.
- [ ] **Step 2: Write failing transcript tests** rendering text, thinking, tools, images, audio, video, and file links while asserting absence of sidebar, right panel, composer, editable inputs, and session actions.
- [ ] **Step 3: Run the focused tests and verify failure**.
- [ ] **Step 4: Implement public root isolation** by branching before credential restore and rendering `Slot` with only non-auth visual providers.
- [ ] **Step 5: Implement responsive route and transcript** with a centered max-width container, safe Markdown, read-only media, download links, semantic theme tokens, `noindex` document metadata, loading state, and one translated unknown/revoked state.
- [ ] **Step 6: Run focused tests and app typecheck**.
- [ ] **Step 7: Commit** with `git commit -m "feat(web): render public session shares"`.

### Task 7: Remove the narrow-screen header new-session action

**Files:**
- Modify: `packages/happy-app/sources/-session/SessionView.tsx`
- Modify: the nearest existing `SessionView` header test or create `packages/happy-app/sources/-session/SessionView.header.test.tsx`

**Interfaces:**
- Removes `SessionNewSessionAction` and `session-header-new-session-button` only from the narrow session header.
- Leaves drawer/compose-home new-session actions unchanged.

- [ ] **Step 1: Add or update a failing header test** asserting the narrow session view has no `session-header-new-session-button` while its menu button remains.
- [ ] **Step 2: Run the focused test and verify failure**.
- [ ] **Step 3: Delete `SessionNewSessionAction`, its branch, unused router callback/imports, and styles** without changing drawer behavior.
- [ ] **Step 4: Run the focused test and app typecheck**.
- [ ] **Step 5: Commit** with `git commit -m "fix(app): simplify the phone session header"`.

### Task 8: Verify, document evidence, and deliver through PR

**Files:**
- Modify: `.github/pull_request_template.md` only if required fields are absent; otherwise no product-code changes.
- Create: immutable visual evidence assets under the repository's existing evidence convention if static capture is possible without starting a server; otherwise request and record the repository's maintainer waiver before merge.

**Interfaces:**
- Produces a pushed `feat/public-session-sharing` branch and PR to `main`.
- Produces test/typecheck results and repository-required `Visible UI cases` evidence matrix.

- [ ] **Step 1: Run focused server tests** for storage and public-share routes.
- [ ] **Step 2: Run focused app tests** for snapshot, API, hook, dialog, dropdown, public transcript, route isolation, and header cleanup.
- [ ] **Step 2a: Validate production routing** by applying the idempotent Caddy transformer to the live configuration in read-only mode, then require the post-merge Web workflow to verify `/share/*` returns HTML with CSP, `no-store`, `noindex`, nosniff, and no-referrer headers.
- [ ] **Step 3: Run `pnpm --filter happy-server typecheck` and `pnpm --filter happy-app typecheck`**.
- [ ] **Step 4: Run `git diff --check`, inspect `git status --short`, and review the complete diff** for secrets, hardcoded colors, untranslated strings, private metadata, and public mutation imports.
- [ ] **Step 5: Add PC Web visual evidence** for the share entry, first-share warning, management state, public transcript, revoked state, and non-default dark theme. If this cannot be captured under the no-server guardrail, obtain the exact maintainer waiver required by `CLAUDE.md` before merge.
- [ ] **Step 6: Push and create a PR** with `gh`, retaining the template and complete visual-evidence matrix.
- [ ] **Step 7: Inspect the rendered PR, wait for CI, and resolve failures**; independently review API authorization, plaintext boundaries, public route isolation, and UI evidence.
- [ ] **Step 8: Merge only after required checks and evidence pass**, then capture the merge SHA.
- [ ] **Step 9: Wait for `Deploy Paws Web to production (on merge to main)` and `Self-hosted OTA production (on merge to main)` for that SHA**, reporting whether Web deployed and whether OTA published or was skipped by path/runtime rules.
