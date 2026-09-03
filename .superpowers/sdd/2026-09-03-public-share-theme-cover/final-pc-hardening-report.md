# Final PC hardening report

Date: 2026-09-03

## Outcome

The final PC review findings are addressed without changing the approved public-share visuals. An unresolved random-cover request or upload normalization is now a publication blocker owned by the share dialog, with visible/live busy feedback and stale-result invalidation. Public Light/Dark/System controls are valid toggle buttons (`aria-pressed`) and reuse the existing desktop tooltip on pointer hover and keyboard focus. Browser regression now exercises a 1280×720 owner dialog, focus restoration, overlay/background scrolling, section geometry, request/console failures, and a separate 390×844 coverless capture.

The primary evidence remains exactly four Before/After pairs. Cases 2 and 3 retain the truthful shared legacy source but apply deterministic, equal-size, pair-matched focus annotations; Case 4 uses the distinct legacy anonymous Copy baseline and an equal-scale crop of the current Copied state. These are evidence annotations/crops, not generated or reconstructed product UI.

## Interaction hardening

- `PublicSessionShareAppearanceControls` reports replacement activity synchronously to its dialog. Random and upload work clears the busy contract only when the matching epoch settles.
- A newer random/upload/remove action, publication-driven `disabled` state, or unmount invalidates the prior epoch. Late picker/provider results cannot replace the newer cover state.
- Create and Update combine publisher/revoke activity with replacement activity. Their event handler also refuses publication while replacement work is unresolved, so a stale selection cannot escape through a synthetic press.
- The appearance controls expose explicit Web `aria-busy`, React Native busy accessibility state, and a polite visible `Preparing…` status using the existing semantic text color.
- Provider-unavailable behavior is unchanged: upload and Remove/coverless paths remain available and the established translated Pexels fallback remains visible.
- Closing the Web share dialog returns focus to the persistent session-header More trigger, which is also the available reopen trigger after the transient Share menu item disappears.
- Public appearance buttons retain their dimensions/colors but now use `button` plus `aria-pressed`. The existing `DesktopShortcutTooltip` displays localized Light/Dark/System labels on hover or focus and dismisses on pointer-out or blur.

## Browser regression hardening

Case 1 runs the owner dialog at 1280×720 before restoring the 1440×900 primary evidence viewport. It asserts 16 px viewport margins, maximum height, real internal scrolling to the privacy notice and final Create action, and a stable background transcript scroll position under wheel input. Escape closes the top layer and focus returns to the persistent More/reopen trigger. A held random-provider request proves Create is disabled and the busy status is announced before the explicit HTTP 503 fallback resolves.

Case 2/3 geometry assertions compare cover bottom, header top/bottom, and transcript top before and after transcript scrolling or mode work. A hit test just inside the first transcript row proves that the header does not cover visible body content. Existing viewport-edge scroll ownership, no-overflow, transcript instance identity, and exact scroll-position assertions remain intact.

Every case attaches listeners for `console.error`, uncaught page errors, `requestfailed`, and every HTTP response at or above 400. The local development logger is deterministically answered with 204. Any failed XHR/fetch, any non-lifecycle request failure, any unexpected console error, or any unexpected HTTP error fails the case. The only HTTP error allowances are exact method/path/status matches for the intentional owner random-provider 503 and revoked public-share 404. Browser media/image requests canceled with `net::ERR_ABORTED` during deliberate source replacement or context teardown are collected but classified as lifecycle aborts; they are not XHR failures.

## TDD and verification

RED observations:

- The new dialog tests initially showed Create/Update remained enabled and `publish` accepted the prior selection while random/upload work was deferred.
- The control tests initially lacked a replacement-busy callback and could not prove resolution, rejection, disable, unmount, or newer-action invalidation.
- The public header test initially found `aria-selected` on ordinary buttons and no hover/focus tooltip state.
- The first 1280×720 browser run passed the bounding-box and scroll assertions but failed focus restoration because the transient Share menu item no longer existed after the dialog opened.
- After focus restoration, the browser busy assertion initially found no Web `aria-busy`; React Native's accessibility state alone did not serialize that attribute.
- The first expanded browser-diagnostics run exposed the local development logging endpoint and intentional image/media teardown aborts. The logger is now stubbed and failed XHR/fetch is distinguished from collected lifecycle-only media cancellation.
- Moving Case 1 through the low-height viewport initially made its authenticated video-style reference incomparable with the 1440×900 anonymous page. Capturing the reference at 1440×900 and resizing only for the dialog fixed the test sequence; no media component changed.

GREEN verification:

- `pnpm --filter happy-app test --run sources/components/PublicSessionShareAppearanceControls.test.tsx sources/components/PublicSessionShareDialog.test.tsx sources/components/PublicSessionTranscript.test.tsx sources/hooks/usePublicSessionAppearance.test.tsx sources/hooks/usePublicSessionShare.test.ts` — 5 files, 56 tests passed.
- `pnpm --filter happy-app typecheck` — passed.
- Focused deterministic covered-share browser case — passed, including toggle tooltip hover/focus/dismiss, `aria-pressed`, geometry, mode persistence, transcript identity/scroll, attribution, and clean diagnostics.
- Focused historical V1/coverless browser case — passed, including desktop/390×844 geometry, real scroll ownership, V1 compatibility, supplemental capture, and clean diagnostics.
- Full browser command with the tracked MP4 and a normal CLI build — 3/3 cases passed in 2.7 minutes.
- `git diff --check` — passed.

The final HTML report is `packages/happy-app/playwright-report/index.html`; Playwright's raw status is `packages/happy-app/test-results/.last-run.json`. Both are generated/ignored workspace results and the final generation is the complete three-case invocation, not a focused rerun.

## Evidence provenance and validation

- Case 1 remains a native 1440×900 owner-dialog pair. The low-height contract is asserted at 1280×720 immediately before the final 1440×900 evidence capture.
- Case 2 uses the verified 1440×900 legacy anonymous baseline as its raw Before source. Both Before and After receive the same 1440×900, no-resize/no-crop blue focus annotation for the cover/header comparison.
- Case 3 uses that same verified 1440×900 legacy source. Both Before and After receive the same 1440×900, no-resize/no-crop green focus annotation for the coverless compact-header comparison. The distinct annotations make the evidence intent and files independently auditable without claiming distinct legacy renderer states.
- Case 4 Before is the truthful 900×240 legacy anonymous Copy state from `docs/evidence/public-share-oss/share-ui-002-copy-before.png`. After is a 900×240 crop at original CSS pixel scale from the 1440×900 current screenshot. The crop aligns the same transcript/code action region and shows the keyboard-focused Copied state.
- `supplemental/case-3-no-cover-390x844.png` is a separate current coverless mobile-width capture. It is disclosed as supplemental and is not counted among the eight primary PNGs.
- Evidence validation found exactly eight primary top-level PNGs plus one supplemental PNG. `file`/`sips` confirmed valid PNG encoding and the declared 1440×900, 900×240, and 390×844 dimensions. All four Before/After hashes differ; all four resulting Before hashes are distinct; no processed temporary files remain.

The complete SHA-256 manifest and exact dimensions are recorded in `docs/pr-evidence/public-share-theme-cover/README.md`.

## Commits

- `7ea09e97` — `fix(web): harden share appearance interactions`
- This evidence/report commit — `test(share): complete PC appearance evidence`

## Remaining concerns and limitations

- Cases 2 and 3 intentionally originate from one legacy renderer capture because the old UI had neither optional-cover presentation nor distinct coverless spacing. The pair-matched annotations disclose comparison intent; they do not imply separate old product states.
- Case 4 is intentionally a focused crop rather than a full-page pair. Both sides are 900×240 at the same CSS-pixel scale, and the legacy source is retained unchanged elsewhere in the repository.
- The diagnostics gate treats only `net::ERR_ABORTED` non-XHR media/image cancellation from deliberate source replacement or page teardown as lifecycle noise. All XHR/fetch failures, other request failures, page errors, console errors, and non-allowlisted HTTP errors remain test failures.
- No product theme colors, spacing, typography, button dimensions, or tooltip styling were introduced in this hardening pass.

## Follow-up PC review hardening — 2026-09-03

The subsequent evidence/diagnostics review is addressed without product visual changes:

- Browser lifecycle cancellation is no longer a blanket `net::ERR_ABORTED` allowance. A request must be an `image` or `media` resource and its URL must match the case's known app-asset, blob, or exact public-share attachment prefix. An aborted favicon exposed by the first strict full run is served as 204 before navigation rather than allowlisted.
- Expected error responses now include exact origin, method, pathname, status, active phase, and count. The random-provider 503 is expected exactly once. The revoked public 404 is enabled only while the revoked anonymous page loads and is expected exactly once; the direct API probe is intentionally outside browser diagnostics.
- Console error suppression is tied to an actually observed/matched expected response key, so a similarly worded 404/503 from another origin or path cannot pass.
- The low-height overlay check first proves the background transcript has a real scroll range and a positive `scrollTop`. The replacement status is asserted as visible and as `aria-live="polite"`.
- E2E captures now write only to `raw/current/`, including the phone supplemental. The tracked `raw/before/` directory contains the owner baseline, shared truthful anonymous baseline, and distinct legacy Copy baseline.
- `scripts/build-public-share-theme-cover-evidence.mjs` is the deterministic evidence boundary. It recreates the eight primary artifacts and supplemental from raw sources, applies the disclosed pair-matched annotations/crop, validates exact sets/dimensions/pair differences/distinct Before hashes, and verifies SHA-256 against `evidence-manifest.json`. The README separates byte-exact reconstruction from an intentional raw-capture refresh.

Follow-up RED evidence:

- The new diagnostics unit suite initially failed because the strict classifier/matcher module did not exist.
- The evidence reconstruction command initially failed with `MODULE_NOT_FOUND` because no deterministic builder was committed.
- The first strict full browser run rejected an aborted `favicon.ico` because it was correctly outside the image/media URL allowlist.
- The next full run showed the browser-observed revoked-page 404 count is one; the apparent second server-log request came from the separate API probe, not the monitored browser. The expectation was corrected to the observed browser boundary.

Follow-up GREEN verification:

- `pnpm --filter happy-app test --run sources/utils/publicSessionSharingDiagnostics.test.ts` — 1 file, 2 tests passed.
- Final affected component/dialog/hook/diagnostics suite — 6 files, 58 tests passed.
- `pnpm --filter happy-app typecheck` — passed after the final browser and evidence runs.
- Normal-build full browser command — 3/3 passed in 2.2 minutes, with the final HTML/raw results produced by that complete run.
- `node scripts/build-public-share-theme-cover-evidence.mjs --refresh-manifest` followed by `node scripts/build-public-share-theme-cover-evidence.mjs --verify` — generated and then byte-verified exactly eight primary artifacts plus one supplemental.

The follow-up commit is recorded in the implementation handoff.

## Final read-only evidence and replacement-state follow-up — 2026-09-03

The final normal-build browser run completed all three cases in 2.9 minutes. Its `raw/current/` screenshots, 390×844 supplemental capture, HTML report, and `.last-run.json` are the final run outputs. No browser rerun was performed after this point.

The evidence builder's verification contract is now genuinely read-only. `--verify` builds the expected artifacts in a fresh temporary directory, validates both the generated and tracked artifact sets against the manifest, byte-compares each generated/tracked PNG, and removes the temporary directory. Only `--refresh-manifest` writes processed top-level/supplemental artifacts and the manifest. A `node:test` integration case runs the real builder in a temporary evidence repository and proves that a manifest mismatch cannot mutate the committed artifact or manifest.

The final code review also identified a replacement-state escape through the active-share Revoke action. Revoke entry is now disabled and handler-guarded while a random/upload replacement is unresolved. As a second safety boundary, appearance-control unmount invalidates the pending epoch and actively clears the parent's busy contract through the latest callback. Unit regressions cover blocked synthetic revoke entry, recovery after replacement completion/cancellation, and unmount cleanup. Pexels image URL validation additionally rejects embedded credentials and non-default HTTPS ports before any image request.

Final follow-up verification:

- Evidence builder integration test — 1/1 passed.
- Read-only `node scripts/build-public-share-theme-cover-evidence.mjs --verify` — passed after one intentional `--refresh-manifest` from the final raw/current capture set.
- Share dialog + appearance controls — 2 files, 28 tests passed.
- Final affected App suite, including transcript, appearance/share hooks, and diagnostics — 6 files, 59 tests passed.
- Pexels cover provider — 1 file, 14 tests passed.
- Happy App and self-hosted Server TypeScript checks — passed.
- Playwright `.last-run.json` remains `passed`; the final HTML report remains the complete three-case invocation.
