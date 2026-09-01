# External Session Sharing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a Codex or Claude Code user publish, manage, and revoke a complete Paws-rendered conversation snapshot without a Paws account.

**Architecture:** A standalone `@wangjs-jacky/paws-share` CLI converts provider JSONL into the shared snapshot contract, blocks unsafe exports, and uploads it through capability-authenticated variants of the existing atomic share pipeline. The server stores only a SHA-256 management-token hash while the CLI keeps the token in a mode-`0600` local record; existing public URLs and the Paws read-only renderer remain unchanged.

**Tech Stack:** TypeScript 5.9, Node 20/24, Commander, Zod 4, Fastify 5, Prisma 6, Vitest 3, Playwright 1.61, ffmpeg.

**Spec:** `docs/superpowers/specs/2026-09-01-external-session-sharing-design.md`

## Global Constraints

- Anonymous sharing must not require a Paws account, daemon, or App install.
- Public pages remain read-only and must not render navigation panels or a composer.
- The management token is generated locally, sent only in `Authorization: PawsShare <token>`, hashed before persistence, and never printed or embedded in public data.
- Anonymous shares expire after 90 days and are renewable only with the local management token.
- Snapshot limits are 20,000 messages and 10 MiB; attachment limits are 50 files, 50 MiB each, and 200 MiB total.
- High-confidence secret findings and unresolved structured attachments block publishing by default.
- Existing authenticated Paws share routes, schemas, data, and links remain compatible.
- Do not create or apply a production migration; update `schema.prisma`, run the repository-approved Prisma client generation, and exercise the schema only in an isolated test database.
- All edits use repository formatting and pass focused tests, typechecks, package verification, and recorded E2E acceptance.

---

### Task 1: Centralize the Public Snapshot Contract

**Files:**
- Create: `packages/happy-wire/src/publicSessionShare.ts`
- Create: `packages/happy-wire/src/publicSessionShare.test.ts`
- Modify: `packages/happy-wire/src/index.ts`
- Modify: `packages/happy-server/sources/app/sessionSharing/publicSessionShareSchemas.ts`
- Modify: `packages/happy-app/sources/sync/publicSessionShareTypes.ts`

**Interfaces:**
- Produces: `publicSessionSnapshotSchema`, `publicShareAssetKindSchema`, `PublicSessionSnapshot`, and `PublicSessionSourceProvider` from `@slopus/happy-wire`.
- Preserves: snapshot `version: 1` and every existing Paws snapshot without `source`.

- [ ] **Step 1: Write contract tests that accept legacy snapshots and provider metadata and reject private provider fields**

```ts
expect(publicSessionSnapshotSchema.parse(legacy).source).toBeUndefined();
expect(publicSessionSnapshotSchema.parse({ ...legacy, source: { provider: 'codex' } }).source).toEqual({ provider: 'codex' });
expect(() => publicSessionSnapshotSchema.parse({ ...legacy, source: { provider: 'codex', sessionId: 'private' } })).toThrow();
```

- [ ] **Step 2: Run the wire test and verify the new export is missing**

Run: `pnpm --filter @slopus/happy-wire exec vitest run src/publicSessionShare.test.ts`

Expected: FAIL because `./publicSessionShare` does not exist.

- [ ] **Step 3: Move the current strict schemas into the wire package and add the display-safe source field**

```ts
export const publicSessionSourceProviderSchema = z.enum(['paws', 'codex', 'claude-code']);
export const publicSessionSnapshotSchema = z.object({
    version: z.literal(1),
    title: z.string().min(1).max(500),
    sharedAt: z.number().int().positive(),
    source: z.object({ provider: publicSessionSourceProviderSchema }).strict().optional(),
    presentation: z.object({ groupToolCalls: z.boolean() }).strict().optional(),
    messages: z.array(publicSessionMessageSchema).max(20_000),
}).strict();
```

- [ ] **Step 4: Re-export the wire definitions in the server compatibility module and align the App type**

```ts
export {
    publicSessionSnapshotSchema,
    publicShareAssetKindSchema,
    type PublicSessionSnapshot,
} from '@slopus/happy-wire';
```

- [ ] **Step 5: Run wire/server tests and the App typecheck**

Run: `pnpm --filter @slopus/happy-wire test && pnpm --filter happy-server-self-host exec vitest run sources/app/api/routes/publicSessionShareRoutes.spec.ts && pnpm --filter happy-app typecheck`

Expected: PASS.

- [ ] **Step 6: Commit the shared contract**

```bash
git add packages/happy-wire packages/happy-server/sources/app/sessionSharing/publicSessionShareSchemas.ts packages/happy-app/sources/sync/publicSessionShareTypes.ts
git commit -m "refactor(share): centralize public snapshot contract"
```

### Task 2: Add Capability Ownership and Authentication

**Files:**
- Modify: `packages/happy-server/prisma/schema.prisma`
- Create: `packages/happy-server/sources/app/sessionSharing/publicSessionShareCapability.ts`
- Create: `packages/happy-server/sources/app/sessionSharing/publicSessionShareCapability.spec.ts`
- Modify: `packages/happy-server/sources/app/api/routes/publicSessionShareRoutes.spec.ts`
- Modify: generated Prisma client files through `pnpm --filter happy-server-self-host generate`

**Interfaces:**
- Produces: `hashShareManagementToken(token: string): Buffer`, `readShareCapabilityAuthorization(value: unknown): Buffer | null`, `verifyShareManagementToken(token: string, storedHash: Uint8Array): boolean`, and `capabilityExpiry(now?: Date): Date`.
- Produces nullable `accountId`, `sessionId`, `managementTokenHash`, `createRequestId`, `sourceProvider`, and `expiresAt` fields on `PublicSessionShare`.

- [ ] **Step 1: Write failing capability tests for format validation, SHA-256 hashing, fixed-length constant-time comparison, and 90-day expiry**

```ts
const token = randomBytes(32).toString('base64url');
expect(readShareCapabilityAuthorization(`PawsShare ${token}`)).toEqual(Buffer.from(token, 'base64url'));
expect(verifyShareManagementToken(token, hashShareManagementToken(token))).toBe(true);
expect(verifyShareManagementToken(`${token}x`, hashShareManagementToken(token))).toBe(false);
expect(capabilityExpiry(new Date('2026-09-01T00:00:00Z')).toISOString()).toBe('2026-11-30T00:00:00.000Z');
```

- [ ] **Step 2: Run the focused test and verify it fails because the capability module is missing**

Run: `pnpm --filter happy-server-self-host exec vitest run sources/app/sessionSharing/publicSessionShareCapability.spec.ts`

Expected: FAIL.

- [ ] **Step 3: Implement the pure capability helpers and ownership invariant**

```ts
export function isValidShareOwnership(value: ShareOwnership): boolean {
    const accountOwned = Boolean(value.accountId && value.sessionId && !value.managementTokenHash);
    const capabilityOwned = Boolean(!value.accountId && !value.sessionId && value.managementTokenHash);
    return accountOwned !== capabilityOwned;
}
```

- [ ] **Step 4: Generalize the Prisma model without creating or applying a migration**

```prisma
accountId            String?
sessionId            String?              @unique
managementTokenHash  Bytes?                @unique
createRequestId      String?               @unique
sourceProvider       String?
expiresAt            DateTime?
```

- [ ] **Step 5: Generate Prisma client types and run capability/server typechecks**

Run: `pnpm --filter happy-server-self-host generate && pnpm --filter happy-server-self-host exec vitest run sources/app/sessionSharing/publicSessionShareCapability.spec.ts && pnpm --filter happy-server-self-host typecheck`

Expected: PASS with no migration created.

- [ ] **Step 6: Commit capability ownership**

```bash
git add packages/happy-server/prisma/schema.prisma packages/happy-server/sources/app/sessionSharing/publicSessionShareCapability.*
git commit -m "feat(server): add capability-owned session shares"
```

### Task 3: Expose Idempotent External Share Routes

**Files:**
- Create: `packages/happy-server/sources/app/api/routes/externalSessionShareRoutes.ts`
- Create: `packages/happy-server/sources/app/api/routes/externalSessionShareRoutes.spec.ts`
- Create: `packages/happy-server/sources/app/sessionSharing/publicSessionSharePipeline.ts`
- Modify: `packages/happy-server/sources/app/api/routes/publicSessionShareRoutes.ts`
- Modify: `packages/happy-server/sources/app/api/api.ts`

**Interfaces:**
- Consumes: wire snapshot schema and capability helpers from Tasks 1-2.
- Produces: create, inspect, replace, prepare-asset, upload, publish, renew, and revoke routes under `/v1/external/session-shares`.
- Produces: shared `prepareAsset`, `uploadAsset`, `publishDraft`, and `revokeShare` pipeline functions used by both authenticated and capability owners.

- [ ] **Step 1: Write route tests for anonymous create idempotency, wrong-token indistinguishability, quotas, atomic publish, renewal, expiry, and idempotent revoke**

```ts
const first = await create({ token, requestId });
const retry = await create({ token, requestId });
expect(retry.json()).toEqual(first.json());
expect((await inspect({ token: wrongToken, shareId: first.json().shareId })).statusCode).toBe(404);
expect((await revoke({ token, shareId: first.json().shareId })).statusCode).toBe(200);
expect((await revoke({ token, shareId: first.json().shareId })).statusCode).toBe(200);
```

- [ ] **Step 2: Run the external route test and verify route registration fails**

Run: `pnpm --filter happy-server-self-host exec vitest run sources/app/api/routes/externalSessionShareRoutes.spec.ts`

Expected: FAIL because the routes do not exist.

- [ ] **Step 3: Extract the account-neutral asset and publication operations from the current route module**

```ts
export type ShareOwner =
    | { kind: 'account'; accountId: string; sessionId: string }
    | { kind: 'capability'; shareId: string; tokenHash: Buffer };
```

- [ ] **Step 4: Implement capability routes with generic 404 authorization failures and lower anonymous quotas**

```ts
const capability = await resolveCapabilityShare(request.params.shareId, request.headers.authorization);
if (!capability) return managedNotFound(reply);
```

- [ ] **Step 5: Make public reads reject expired capability shares through the existing generic not-found branch**

```ts
const expired = Boolean(share.expiresAt && share.expiresAt <= new Date());
if (expired || share.revokedAt || !share.publishedAt || !share.snapshot) return publicNotFound(reply);
```

- [ ] **Step 6: Run all share route, storage, cleanup, and rate-limit tests**

Run: `pnpm --filter happy-server-self-host exec vitest run sources/app/api/routes/publicSessionShareRoutes.spec.ts sources/app/api/routes/externalSessionShareRoutes.spec.ts sources/app/sessionSharing/publicSessionShareStorage.spec.ts sources/app/sessionSharing/publicSessionShareCleanup.spec.ts sources/app/sessionSharing/publicSessionShareRateLimit.spec.ts`

Expected: PASS.

- [ ] **Step 7: Commit the external API**

```bash
git add packages/happy-server/sources/app/api packages/happy-server/sources/app/sessionSharing
git commit -m "feat(server): expose anonymous session share API"
```

### Task 4: Scaffold the Standalone CLI and Secure Local Store

**Files:**
- Modify: `pnpm-workspace.yaml`
- Create: `packages/paws-share/package.json`
- Create: `packages/paws-share/tsconfig.json`
- Create: `packages/paws-share/vitest.config.ts`
- Create: `packages/paws-share/bin/paws-share.mjs`
- Create: `packages/paws-share/src/records.ts`
- Create: `packages/paws-share/src/records.test.ts`
- Create: `packages/paws-share/src/types.ts`
- Create: `packages/paws-share/src/index.ts`

**Interfaces:**
- Produces: `ShareRecordStore` with `load`, `save`, `list`, `get`, and `remove`; `ShareRecord` contains the management token but serialization is atomic and mode `0600`.
- Produces: a side-effect-free library entry and `paws-share` executable.

- [ ] **Step 1: Write failing record tests for atomic replacement, mode `0600`, token redaction, and `PAWS_SHARE_HOME` isolation**

```ts
await store.save(record);
expect((await stat(join(home, 'shares.json'))).mode & 0o777).toBe(0o600);
expect(JSON.stringify(store.toPublicRecord(record))).not.toContain(record.managementToken);
```

- [ ] **Step 2: Run the package test and verify the store module is missing**

Run: `pnpm --filter @wangjs-jacky/paws-share exec vitest run src/records.test.ts`

Expected: FAIL.

- [ ] **Step 3: Add the workspace package and implement an atomic JSON store using a same-directory temporary file, `fsync`, rename, and chmod**

```ts
await writeFile(tempPath, payload, { mode: 0o600 });
await rename(tempPath, recordPath);
await chmod(recordPath, 0o600);
```

- [ ] **Step 4: Build and run help/version from the package binary**

Run: `pnpm install && pnpm --filter @wangjs-jacky/paws-share build && node packages/paws-share/bin/paws-share.mjs --help && node packages/paws-share/bin/paws-share.mjs --version`

Expected: exit 0 without reading provider stores.

- [ ] **Step 5: Commit the package foundation**

```bash
git add pnpm-workspace.yaml pnpm-lock.yaml packages/paws-share
git commit -m "feat(cli): scaffold paws-share package"
```

### Task 5: Convert Codex and Claude Code Transcripts

**Files:**
- Create: `packages/paws-share/src/adapters/types.ts`
- Create: `packages/paws-share/src/adapters/codex.ts`
- Create: `packages/paws-share/src/adapters/codex.test.ts`
- Create: `packages/paws-share/src/adapters/claudeCode.ts`
- Create: `packages/paws-share/src/adapters/claudeCode.test.ts`
- Create: `packages/paws-share/src/adapters/discover.ts`
- Create: `packages/paws-share/src/adapters/discover.test.ts`
- Create: `packages/paws-share/test/fixtures/codex-session.jsonl`
- Create: `packages/paws-share/test/fixtures/claude-code-session.jsonl`
- Create: `packages/paws-share/test/fixtures/attachment.svg`

**Interfaces:**
- Produces: `TranscriptAdapter.discover`, `.inspect`, and `.convert` returning a wire-valid snapshot plus resolved attachments.
- Produces: `discoverCurrentSession({ cwd, codexHome, claudeHome })`, which returns one candidate or a typed ambiguity error.

- [ ] **Step 1: Add fixtures and failing tests for messages, thinking, tool/result pairing, resumed-history deduplication, source labels, attachments, and ambiguity**

```ts
const converted = await codexAdapter.convert(candidate);
expect(converted.snapshot.source).toEqual({ provider: 'codex' });
expect(converted.snapshot.messages.flatMap(message => message.blocks).map(block => block.type)).toContain('tool');
expect(converted.attachments).toHaveLength(1);
```

- [ ] **Step 2: Run adapter tests and verify they fail on missing implementations**

Run: `pnpm --filter @wangjs-jacky/paws-share exec vitest run src/adapters`

Expected: FAIL.

- [ ] **Step 3: Implement streaming JSONL readers and provider-specific event normalization without exporting raw IDs or paths**

```ts
return publicSessionSnapshotSchema.parse({
    version: 1,
    title,
    sharedAt: clock.now(),
    source: { provider: 'claude-code' },
    presentation: { groupToolCalls: true },
    messages,
});
```

- [ ] **Step 4: Resolve only structured references and explicit attachments; enforce allowed roots and stable source mtime/size**

```ts
const after = await stat(candidate.path);
if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new TranscriptChangedError();
```

- [ ] **Step 5: Run adapter tests and typecheck**

Run: `pnpm --filter @wangjs-jacky/paws-share exec vitest run src/adapters && pnpm --filter @wangjs-jacky/paws-share typecheck`

Expected: PASS.

- [ ] **Step 6: Commit provider conversion**

```bash
git add packages/paws-share/src/adapters packages/paws-share/test/fixtures
git commit -m "feat(cli): convert Codex and Claude Code sessions"
```

### Task 6: Block Unsafe Exports

**Files:**
- Create: `packages/paws-share/src/security/secretScanner.ts`
- Create: `packages/paws-share/src/security/secretScanner.test.ts`
- Create: `packages/paws-share/src/security/exportPolicy.ts`
- Create: `packages/paws-share/src/security/exportPolicy.test.ts`

**Interfaces:**
- Produces: `scanShareExport(snapshot, attachments): SecretFinding[]` with redacted locations.
- Produces: `assertShareExportSafe(inspection, options)` that blocks high-confidence findings and unresolved attachments unless the documented explicit override is present.

- [ ] **Step 1: Write failing tests for private keys, vendor token prefixes, bearer tokens, `.env` credentials, redacted output, warnings, and unresolved attachments**

```ts
const findings = scanText('Authorization: Bearer sk-example-secret');
expect(findings[0]).toMatchObject({ severity: 'block', location: expect.any(String) });
expect(JSON.stringify(findings)).not.toContain('sk-example-secret');
```

- [ ] **Step 2: Run security tests and verify they fail**

Run: `pnpm --filter @wangjs-jacky/paws-share exec vitest run src/security`

Expected: FAIL.

- [ ] **Step 3: Implement bounded scanners over snapshot text and small text attachments, returning only type/location/fingerprint**

```ts
return { rule: 'bearer-token', severity: 'block', location, fingerprint: sha256(secret).slice(0, 12) };
```

- [ ] **Step 4: Implement export policy with separate `allowSensitive` and excluded-attachment controls**

```ts
if (inspection.unresolvedAttachments.length > 0) throw new UnsafeExportError('unresolved-attachments');
if (!options.allowSensitive && findings.some(item => item.severity === 'block')) throw new UnsafeExportError('sensitive-content');
```

- [ ] **Step 5: Run security tests and commit**

Run: `pnpm --filter @wangjs-jacky/paws-share exec vitest run src/security`

Expected: PASS.

```bash
git add packages/paws-share/src/security
git commit -m "feat(cli): block unsafe session exports"
```

### Task 7: Implement API Client and CLI Commands

**Files:**
- Create: `packages/paws-share/src/api/client.ts`
- Create: `packages/paws-share/src/api/client.test.ts`
- Create: `packages/paws-share/src/share.ts`
- Create: `packages/paws-share/src/share.test.ts`
- Create: `packages/paws-share/src/cli.ts`
- Create: `packages/paws-share/src/cli.test.ts`

**Interfaces:**
- Consumes: converted snapshot/attachments, safety inspection, external API, and local record store.
- Produces: `inspect`, `share`, `list`, `renew`, and `revoke` commands with stable human and JSON output that never contains the management token.

- [ ] **Step 1: Write failing client tests for request headers, retry/idempotency, upload hashes, publish ordering, and token-free error/output serialization**

```ts
expect(request.headers.get('Authorization')).toBe(`PawsShare ${token}`);
expect(request.headers.get('Idempotency-Key')).toBe(requestId);
expect(stdout).not.toContain(token);
```

- [ ] **Step 2: Write failing CLI tests for disclosure, required confirmation, JSON share output, list redaction, renew, revoke, and ambiguity**

```ts
expect(json).toEqual(expect.objectContaining({ publicUrl: expect.stringMatching(/^https?:\/\//), expiresAt: expect.any(String) }));
expect(JSON.stringify(json)).not.toContain(token);
```

- [ ] **Step 3: Implement a bounded retrying API client with token redaction at the error boundary**

```ts
const headers = { Authorization: `PawsShare ${token}`, 'Idempotency-Key': requestId };
throw new PawsShareApiError(response.status, await readSafeError(response));
```

- [ ] **Step 4: Implement inspect/share/list/renew/revoke orchestration and Commander commands**

```ts
program.command('share').option('--current').option('--source <provider>').option('--session <id-or-path>').option('--yes').option('--json').action(runShare);
```

- [ ] **Step 5: Run CLI/API tests, full package tests, and typecheck**

Run: `pnpm --filter @wangjs-jacky/paws-share exec vitest run src/api src/share.test.ts src/cli.test.ts && pnpm --filter @wangjs-jacky/paws-share test && pnpm --filter @wangjs-jacky/paws-share typecheck`

Expected: PASS.

- [ ] **Step 6: Commit the complete CLI flow**

```bash
git add packages/paws-share/src packages/paws-share/bin
git commit -m "feat(cli): publish and manage public session shares"
```

### Task 8: Ship the Portable Agent Skill and Pack Contract

**Files:**
- Create: `packages/paws-share/skills/share-session/SKILL.md`
- Create: `packages/paws-share/src/installSkill.ts`
- Create: `packages/paws-share/src/installSkill.test.ts`
- Create: `packages/paws-share/scripts/verify-pack.mjs`
- Create: `packages/paws-share/scripts/prepare-release.mjs`
- Modify: `packages/paws-share/package.json`
- Create: `packages/paws-share/README.md`

**Interfaces:**
- Produces: `paws-share install-skill --target codex|claude-code|all`.
- Produces: a pack containing only `dist`, `bin`, `skills`, `README.md`, `LICENSE`, and `package.json`.

- [ ] **Step 1: Write failing install tests for both skill roots, non-destructive updates, and no embedded credentials**

```ts
await installSkill({ target: 'all', homes });
expect(await readFile(codexSkill, 'utf8')).toContain('paws-share inspect --current --json');
expect(await readFile(claudeSkill, 'utf8')).toContain('paws-share share --current --yes --json');
```

- [ ] **Step 2: Implement the provider-neutral skill with disclosure-first rules and the installer**

```md
Never invoke `share --yes` until the user has explicitly requested a public link and the `inspect` disclosure has no unresolved blockers.
```

- [ ] **Step 3: Add pack verification that installs the exact tarball into a fresh temporary project and runs help/version/fixture inspection**

```js
const packed = execFileSync('pnpm', ['pack', '--pack-destination', tempDir], { cwd: packageDir });
execFileSync('npm', ['install', tarballPath], { cwd: cleanProject });
execFileSync(binPath, ['inspect', '--source', 'codex', '--session', fixturePath, '--json']);
```

- [ ] **Step 4: Run install tests and exact pack verification**

Run: `pnpm --filter @wangjs-jacky/paws-share exec vitest run src/installSkill.test.ts && pnpm --filter @wangjs-jacky/paws-share verify:pack`

Expected: PASS and print tarball path plus SHA-256 without a management token.

- [ ] **Step 5: Commit the skill and release contract**

```bash
git add packages/paws-share
git commit -m "feat(cli): package session-sharing agent skill"
```

### Task 9: Preserve Same-Renderer Public UX

**Files:**
- Modify: `packages/happy-app/sources/components/PublicSessionTranscript.tsx`
- Modify: `packages/happy-app/sources/components/PublicSessionTranscript.test.tsx`

**Interfaces:**
- Consumes: optional snapshot source metadata.
- Preserves: the existing shared transcript renderer and all read-only constraints.
- Produces: a small display-only `Codex`, `Claude Code`, or `Paws` source label without creating a second transcript layout.

- [ ] **Step 1: Write failing render tests for provider labels and absence of authenticated chrome/composer controls**

```ts
expect(screen.getByText('Codex')).toBeTruthy();
expect(screen.queryByTestId('session-composer')).toBeNull();
expect(screen.queryByTestId('left-sidebar')).toBeNull();
```

- [ ] **Step 2: Run the public page test and verify the source label is missing**

Run: `pnpm --filter happy-app exec vitest run sources/components/PublicSessionTranscript.test.tsx`

Expected: FAIL.

- [ ] **Step 3: Add only the provider label to the existing page header; keep existing renderer, grouping, attachment components, and route shell**

```tsx
{snapshot.source ? <Text>{sourceLabels[snapshot.source.provider]}</Text> : null}
```

- [ ] **Step 4: Run focused public-page tests and App typecheck**

Run: `pnpm --filter happy-app exec vitest run sources/components/PublicSessionTranscript.test.tsx && pnpm --filter happy-app typecheck`

Expected: PASS.

- [ ] **Step 5: Commit the same-renderer label**

```bash
git add packages/happy-app/sources/app packages/happy-app/sources/sync
git commit -m "feat(app): label externally shared sessions"
```

### Task 10: Record the Isolated End-to-End Acceptance Video

**Files:**
- Create: `scripts/run-external-share-e2e.ts`
- Create: `packages/happy-app/e2e/external-session-share.spec.ts`
- Modify: `package.json`
- Create at runtime: `artifacts/external-session-share-e2e/<run-id>/acceptance.mp4`
- Create at runtime: `artifacts/external-session-share-e2e/<run-id>/case.json`
- Create at runtime: `artifacts/external-session-share-e2e/<run-id>/screenshots/*.png`
- Create at runtime: `artifacts/external-session-share-e2e/<run-id>/trace.zip`

**Interfaces:**
- Consumes: the exact packed CLI, isolated database/object storage, bundled App, and external share API.
- Produces: stable Case metadata plus a real 1280×720 MP4 demonstrating Codex publish, Claude Code publish, attachment viewing, no panels/composer, token-free URLs, and revoke behavior.

- [ ] **Step 1: Read and follow the `web-e2e` skill, then define one automated Case with machine-checkable assertions**

```ts
const expected = {
    providers: ['Codex', 'Claude Code'],
    forbiddenSelectors: ['[data-testid="session-composer"]', '[data-testid="left-sidebar"]', '[data-testid="right-sidebar"]'],
};
```

- [ ] **Step 2: Make the runner create a temporary schema via isolated `prisma db push`, install the packed CLI, launch the server/App on reserved local ports, and register teardown before startup**

```ts
const cleanup = createCleanupStack();
try { await runCase(context); } finally { await cleanup.run(); }
```

- [ ] **Step 3: Publish both fixtures through the installed CLI and assert stdout, public URLs, snapshots, and server logs contain no management token**

```ts
for (const token of localRecordTokens) {
    expect(allCapturedOutput).not.toContain(token);
}
```

- [ ] **Step 4: Record anonymous browser validation and revoke one share using only its local record**

```ts
await page.goto(codexPublicUrl);
await expect(page.getByText('Codex')).toBeVisible();
await expect(page.locator('[data-testid="session-composer"]')).toHaveCount(0);
await runPackedCli(['revoke', codexPublicId, '--json']);
await expect(page.reload().then(() => page.getByText(/not found/i))).resolves.toBeTruthy();
```

- [ ] **Step 5: Run the recorded Case and validate the MP4 metadata**

Run: `HAPPY_E2E_RECORD=1 pnpm test:e2e:external-share`

Expected: Case PASS, with screenshots, trace, logs, and `acceptance.webm` or MP4 source.

Run: `ffmpeg -y -i <recorded-video> -c:v libx264 -pix_fmt yuv420p -movflags +faststart <acceptance.mp4> && ffprobe -v error -show_entries format=duration -show_entries stream=width,height,codec_name -of json <acceptance.mp4>`

Expected: H.264 MP4, 1280×720, non-zero duration.

- [ ] **Step 6: Commit the reusable E2E Case but not transient artifacts**

```bash
git add scripts/run-external-share-e2e.ts packages/happy-app/e2e/external-session-share.spec.ts package.json
git commit -m "test(e2e): record external session sharing flow"
```

### Task 11: Final Verification, Review, and PR

**Files:**
- Modify: `docs/superpowers/plans/2026-09-01-external-session-sharing.md` to mark completed steps.
- Create at runtime: `artifacts/external-session-share-e2e/<run-id>/verification.txt`.

**Interfaces:**
- Produces: a reviewable branch, exact test evidence, packed tarball checksum, E2E MP4, and GitHub PR.

- [ ] **Step 1: Run all touched-package checks from a clean working tree**

Run: `pnpm --filter @slopus/happy-wire test && pnpm --filter happy-server-self-host test && pnpm --filter @wangjs-jacky/paws-share test && pnpm --filter @wangjs-jacky/paws-share verify:pack && pnpm --filter happy-app typecheck`

Expected: PASS.

- [ ] **Step 2: Run repository hygiene and secret checks**

Run: `git diff --check origin/main...HEAD && git status --short && rg -n "PawsShare [A-Za-z0-9_-]{40,}|managementToken\"\s*:" artifacts packages/paws-share --glob '!**/*.test.ts'`

Expected: clean diff; no leaked runtime management token.

- [ ] **Step 3: Review the complete diff for ownership, authorization, idempotency, expiry, snapshot fidelity, and unchanged account routes; fix and rerun relevant checks**

```text
Gate: no unresolved P0/P1 issue, no production database mutation, no second public renderer.
```

- [ ] **Step 4: Push and create a PR with test commands, release boundary, migration note, public UI cases, artifact checksums, and E2E video location**

Run: `git push -u origin external-session-share && gh pr create --repo wangjs-jacky/happy --base main --head external-session-share --title "feat(share): publish Codex and Claude Code sessions" --body-file <prepared-body>`

Expected: open PR URL.

- [ ] **Step 5: Verify the remote PR head matches local HEAD and deliver the MP4 through the Happy file transport when available**

Run: `gh pr view --repo wangjs-jacky/happy --json url,headRefOid,statusCheckRollup`

Expected: `headRefOid` equals `git rev-parse HEAD`; final handoff includes PR, checks, known migration/release boundary, and playable acceptance video.
