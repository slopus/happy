# Final server hardening report

Date: 2026-09-03

## Outcome

The final whole-branch server findings are implemented without changing the approved public-share lifecycle. Public cover provider work now has provider-specific distributed budgets and bounded in-process concurrency, imported covers reserve their maximum transformed size before remote work, uploaded covers are validated from bounded object-storage bytes before publication, and the external capability flow publishes V2 covers through the same manifest and byte validator. Hosted production storage fails closed without complete object-storage configuration unless a self-host explicitly opts into local public-share storage. Public asset responses deliberately remain `Cache-Control: no-store`.

The import/clone claim metadata, claim identity matching, and best-effort object cleanup are centralized in `publicSessionCoverClaims.ts`; the shared manifest and decoded-byte rules are centralized in `publicSessionShareAssetValidation.ts`.

## Availability and quota decisions

- Provider rate budgets use the existing Redis-backed rate-limit primitive, with its existing bounded local fallback: 20 requests/account/hour and 180 requests/global/hour. The global budget leaves headroom below the default Pexels 200/hour quota.
- In-flight work is limited to 2/account and 4/process across random and import endpoints. Import holds the slot through provider fetch, Sharp decode/transform, and object-storage put. Rejections return HTTP 429 with `Retry-After`.
- A pending import row atomically reserves 10 MiB, the maximum transformed output, before Pexels or Sharp runs. Expired-lease takeover charges only the reservation delta. Finalization replaces the reservation with actual bytes rather than adding actual bytes a second time.
- Provider/storage failures release concurrency and remove the owned reservation where safe. Ambiguous cleanup preserves the bounded lease/row for recovery rather than risking deletion of a peer's claim.

## Uploaded cover validation

- Wire V2 cover MIME is restricted to JPEG, PNG, WebP, and AVIF. SVG, GIF, unknown, and executable types are rejected.
- Ordinary uploaded and ordinary cloned covers are read through the bounded storage API; no disk staging is used.
- Publication verifies exact stored/snapshot byte count, SHA-256, decoded format/MIME, oriented dimensions, one page/no animation, maximum input dimension, and 60-million input/output pixel bounds. A forced one-pixel Sharp render proves the image can actually decode.
- Server-imported canonical Pexels covers retain their exact persisted canonical metadata correlation path.
- The app queue uses the same safe MIME set. If the picker returns an unsupported format, the existing translated `sessionShare.coverUploadFailed` alert is shown and the current cover remains selected.

## External route, storage, and cache policy

- Authenticated external/capability publication now includes V2 covers in the asset manifest and rejects missing, extra, corrupt, mismatched, or attributed/forged-provider covers before publication.
- Production public-share put/copy/read/exists/delete paths require complete S3/OSS settings. `PUBLIC_SHARE_LOCAL_STORAGE=enabled` is the explicit production self-host escape hatch; development/test local storage remains supported and `.env.dev` opts in visibly.
- Server README/environment documentation lists the S3 variables and the server-only `PEXELS_API_KEY` and warns not to expose secrets.
- The E2E route fixture no longer injects an immutable cache header. A real attachment endpoint assertion proves `Cache-Control: no-store`. Design and visual-evidence documentation records that object keys/URLs are generation-addressed while browser/CDN immutable caching is intentionally disabled until purge support exists.

## TDD evidence

RED observations:

- Wire MIME cases initially accepted four unsafe cover types.
- New bounded-storage/production-guard assertions initially failed before the storage guard and byte reader existed.
- The shared byte-validator suite initially failed because the module did not exist; its first implementation also exposed Sharp's AVIF-as-HEIF metadata representation before that canonical mapping was added.
- Three owner-route corrupt/mislabeled/dimension cases initially published successfully.
- External valid/missing/corrupt V2 cases initially failed (the extra-asset characterization was already rejected).
- The three provider availability/reservation regressions initially failed: no limiter module, zero-byte pending claims, and no pre-provider quota rejection.
- App RED had three failures: unsupported picker GIF was accepted, persisted GIF was accepted, and persisted AVIF was rejected.
- The first combined server regression pass exposed two compatibility issues: incomplete uploads were validated before returning the established incomplete-upload error, and an old non-image-cover fixture was now wire-invalid. Validation ordering and the fixture were corrected without changing the approved error convention.

GREEN verification:

- `pnpm --filter @slopus/happy-wire test` — build/typecheck succeeded; 5 files, 55 tests passed.
- `pnpm --filter happy-server-self-host exec vitest run sources/app/api/routes/publicSessionShareRoutes.spec.ts sources/app/api/routes/externalSessionShareRoutes.spec.ts sources/app/sessionSharing/publicSessionShareAssetValidation.spec.ts sources/app/sessionSharing/publicSessionCoverAvailability.spec.ts sources/app/sessionSharing/publicSessionCoverProvider.spec.ts sources/app/sessionSharing/publicSessionShareStorage.spec.ts` — 6 files, 110 tests passed.
- `pnpm --filter happy-server-self-host typecheck` — passed.
- `pnpm --filter happy-app exec vitest run sources/components/PublicSessionShareAppearanceControls.test.tsx sources/components/PublicSessionTranscript.test.tsx sources/hooks/usePublicSessionShare.test.ts sources/sync/publicSessionShareQueue.test.ts sources/sync/publicSessionShareQueuePersistence.test.ts sources/sync/publicSessionShareQueueRuntime.test.ts` — 6 files, 59 tests passed.
- `pnpm --filter happy-app typecheck` — passed.
- `git diff --check` — passed.

Final focused total: 224 tests passed across wire, server, and affected app suites.

One initial app typecheck was started concurrently with the wire build and observed the wire build's temporary removal of `dist`; a sequential rerun after the build then identified two legitimate widened test-fixture MIME literals. Those fixtures were narrowed, and the final app typecheck passed.

## Commits

- `0c5755e6` — `fix(share): harden public cover publication`
- `fb9772b7` — `docs(share): require production cover storage`

This report is committed separately after the exact implementation/documentation hashes above are known.

## Remaining concerns

- The global request budget is distributed when Redis is configured; deployments without Redis inherit the project's process-local rate-limit fallback. The explicit in-flight semaphore is intentionally process-global, not distributed.
- No full browser evidence run was repeated because the E2E change only removes a synthetic response header. The real Fastify attachment endpoint header is covered directly, while the affected app component/queue/publisher/renderer tests and typecheck were rerun.
- Production local storage remains available only through the documented explicit opt-in. Hosted deployments should configure durable OSS/S3 and Redis to obtain cross-process quota enforcement.

## Follow-up hardening review — 2026-09-03

Commit `2f38fd8a` (`fix(share): validate every cover object`) resolves the subsequent independent review findings:

- User asset names now pass through one shared owner/external normalization schema before reserved-name validation. Both POSIX and Windows separators are reduced to the literal basename; percent-looking strings are not decoded. The current `__paws_internal__:` namespace and both legacy `pexels-cover-v1:` / `pexels-cover-pending:` namespaces are rejected after normalization.
- Every published cover now undergoes bounded storage read, exact byte-count/hash verification, Sharp format/page/pixel validation, oriented-dimension comparison, and a real decode. An internal Pexels metadata name adds provenance checks but never bypasses byte validation. Valid imported covers and their clones still publish.
- `image/avif` is now an allowed inline public image response MIME. The route regression verifies `Content-Type: image/avif`, inline disposition, `nosniff`, and `no-store` together.
- Availability failures now use the provider-neutral `Cover provider is busy` message.

Clarification to the earlier availability wording: the process-local rate limiter is selected only when `REDIS_URL` is absent. When Redis is configured, Redis evaluation errors propagate and provider work fails closed; the follow-up suite explicitly verifies the provider operation is not invoked. The in-flight semaphore remains intentionally per process.

Follow-up RED:

- The first focused run had 4 failing files, 10 failed tests, and 76 passing tests. The shared asset-name module was absent; three normalized owner reserved-name cases and the external Windows-path case returned 200; a Windows ordinary name retained a sanitized path prefix; canonical same-length corruption, wrong dimensions, and wrong format all published; AVIF was served as `application/octet-stream`; and the availability error still said `Random cover provider is busy`.

Follow-up GREEN:

- `pnpm --filter happy-server-self-host exec vitest run sources/app/api/routes/publicSessionShareRoutes.spec.ts sources/app/api/routes/externalSessionShareRoutes.spec.ts sources/app/sessionSharing/publicSessionShareAssetNames.spec.ts sources/app/sessionSharing/publicSessionShareAssetValidation.spec.ts sources/app/sessionSharing/publicSessionCoverAvailability.spec.ts sources/app/sessionSharing/publicSessionCoverProvider.spec.ts sources/app/sessionSharing/publicSessionShareStorage.spec.ts` — 7 files, 128 tests passed.
- `pnpm --filter happy-server-self-host typecheck` — passed.
- `git diff --check` and `git diff --cached --check` — passed.
- Wire/app tests were not rerun because this follow-up does not change their interface or MIME acceptance contract; AVIF was already accepted at the wire/app boundary and this change only corrects server response handling.

Follow-up concerns: none beyond the deployment characteristics already documented above. Canonical imported and cloned paths, ordinary uploaded owner covers, and external capability covers all converge on the same byte validator at publication.
