# Public Share UI and OSS-Only Web Delivery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Polish the anonymous public-session page and make Alibaba Cloud OSS the only storage location for production Web artifacts while the canonical Caddy origin remains unchanged.

**Architecture:** The UI work stays inside reusable transcript components: a document-style public header, a provider-independent code-copy control, and category-aware agent-work headers. The delivery work uploads a complete immutable OSS release plus Metro-compatible root assets, switches one stable OSS HTML entry last, proxies that entry through Caddy, and removes the guarded legacy server tree only after live verification.

**Tech Stack:** React Native Web, Expo Router, Unistyles, Vitest/react-test-renderer, Playwright, Bash, Node.js test runner, Alibaba Cloud `aliyun ossutil`, Caddy, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-09-02-public-share-ui-oss-web-design.md`

## Global Constraints

- The canonical origin remains `https://47.115.228.20:8443`; production publishing happens only from merged `main` through `.github/workflows/web-production-deploy.yml`.
- The root workspace stays clean `main`; all edits and commits occur in `/Users/jacky/jacky-github/happy--share-page-oss` on `feat/share-page-oss`.
- Public shares remain anonymous, read-only, `no-store`, `noindex`, `nosniff`, and `no-referrer`; public attachments remain API-backed.
- Every Web artifact, including `index.html` and `.paws-release-revision`, is stored in OSS; no active route reads `/var/www/happy-web` after migration.
- All visible colors and interaction states use current Unistyles semantic tokens and must be checked in `ginghamDark` as well as the default theme.
- No production code is written before a focused failing test demonstrates the missing behavior.
- Visible cases use matching 1440-by-900 Before/After evidence; interactive cases also retain a final passing MP4.

## Case Table

| Case | User-observable result | Before/base | Independent review | E2E | Interaction review | Video | After | PR |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| SHARE-UI-001 | Document-style title, neutral chat mark, and clock-labelled publication time align with the transcript. | User screenshots plus base `b816a12f` replay | pending | required | pending | required | pending | pending |
| SHARE-UI-002 | Code copy changes from copy icon/label to check/`Copied` for 1.8 seconds and reports failure inline. | User screenshot plus base `b816a12f` replay | pending | required | pending | required | pending | pending |
| SHARE-UI-003 | Header, work-group, chevron, and scroll icons visibly render. | User screenshots plus base `b816a12f` replay | pending | required | pending | required | pending | pending |
| SHARE-UI-004 | Copy is keyboard accessible and announces status through a polite live region. | Base `b816a12f` behavior | pending | required | pending | required | pending | pending |
| WEB-OSS-001..005 | OSS-only files, canonical SPA routing, headers, atomic switch, rollback, and guarded cleanup all pass. | Existing scripts and live HTTP headers | pending | command-level integration | not-required: infrastructure behavior | not-required | command logs | pending |

---

### Task 1: Provider-independent code-copy feedback

**Files:**
- Create: `packages/happy-app/sources/components/markdown/CodeBlockCopyButton.tsx`
- Create: `packages/happy-app/sources/components/markdown/CodeBlockCopyButton.test.tsx`
- Modify: `packages/happy-app/sources/components/markdown/MarkdownView.tsx:189-238`

**Interfaces:**
- Consumes: `content: string`, `visible: boolean`, `Clipboard.setStringAsync`, `t('common.copy')`, `t('common.copied')`, and `t('markdown.copyFailed')`.
- Produces: `CodeBlockCopyButton({ content, visible })`, test ID `markdown-code-copy`, feedback test ID `markdown-code-copy-feedback`, and the local state machine `idle | copied | failed`.

- [ ] **Step 1: Write the failing success-state test**

  Render the real button with fake timers and a clipboard stub that resolves. Assert the initial accessibility label is `common.copy`, activation writes the exact code string, the icon changes from `copy-outline` to `checkmark`, `common.copied` appears in a polite live region, and advancing 1,800 ms returns to idle. The production mutation this catches is removal of the local success transition or timer reset.

- [ ] **Step 2: Run the focused test and verify RED**

  Run:

  ```bash
  pnpm --filter happy-app exec vitest run sources/components/markdown/CodeBlockCopyButton.test.tsx
  ```

  Expected: failure because `CodeBlockCopyButton.tsx` does not exist.

- [ ] **Step 3: Implement the minimal success state**

  Create a semantic-token Pressable that renders `copy-outline`/`common.copy` while idle and `checkmark`/`common.copied` after the awaited clipboard write. Set `accessibilityRole="button"`, update `accessibilityLabel`, place feedback in `accessibilityLiveRegion="polite"`, retain feedback visibility even when hover ends, and clear the timer in effect cleanup.

- [ ] **Step 4: Run the focused test and verify GREEN**

  Run the command from Step 2 and require a clean pass with no act warnings.

- [ ] **Step 5: Write and verify the failing failure-state test**

  Make the clipboard stub reject. Assert no copied state appears, the icon becomes `alert-circle-outline`, `markdown.copyFailed` appears in a polite live region, and the state resets after 1,800 ms. Expected RED reason: the initial component has only the success branch.

- [ ] **Step 6: Implement the failure branch and integrate it into Markdown**

  Catch the clipboard error locally, render failed feedback, and remove both copy-path `Modal.alert` calls from `RenderCodeBlock`. Pass `visible={Platform.OS !== 'web' || isHovered}` to the new component. Keep Markdown's unrelated long-press error modal unchanged.

- [ ] **Step 7: Run tests and commit**

  Run the focused test plus `PublicSessionTranscript.test.tsx`, then commit:

  ```bash
  git add packages/happy-app/sources/components/markdown/CodeBlockCopyButton.tsx packages/happy-app/sources/components/markdown/CodeBlockCopyButton.test.tsx packages/happy-app/sources/components/markdown/MarkdownView.tsx
  git commit -m "fix(app): show inline code copy feedback"
  ```

### Task 2: Notion-style public header and complete work-group iconography

**Files:**
- Modify: `packages/happy-app/sources/components/PublicSessionTranscript.tsx`
- Modify: `packages/happy-app/sources/components/PublicSessionTranscript.test.tsx`
- Modify: `packages/happy-app/sources/components/ToolGroupView.tsx`
- Create: `packages/happy-app/sources/components/ToolGroupView.test.tsx`

**Interfaces:**
- Consumes: `layout.maxWidth`, Unistyles semantic tokens, `Ionicons`, `getGroupSummaryCategory(messages)`.
- Produces: `public-session-header-inner`, `public-session-title`, `public-session-published-at`, a `chatbubble-ellipses-outline` mark, a `time-outline` metadata icon, and a category icon on `conversation-agent-work-toggle`.

- [ ] **Step 1: Extend the public-header test and verify RED**

  Assert the header has an aligned inner frame, the title is 22 px with header semantics, the leading icon is `chatbubble-ellipses-outline`, and publication metadata includes `time-outline`. The mutation caught is restoration of the saturated paw tile or compact 15 px title.

- [ ] **Step 2: Implement the document header and verify GREEN**

  Center an inner row at the transcript width, use a 36-by-36 neutral semantic surface with hairline border, a 22/28 semibold title, and a 12 px clock metadata row. Use only `theme.colors.*` values and keep the existing read-only transcript contract.

- [ ] **Step 3: Write the agent-work category test and verify RED**

  Render `AgentWorkGroupView` with one completed `Read` tool call. Assert the outer collapse header contains the real Octicons `eye` glyph and the real Ionicons chevron. The mutation caught is omitting `category` when invoking `CollapseHeader`.

- [ ] **Step 4: Pass the computed category and verify GREEN**

  Memoize `getGroupSummaryCategory(group.messages)` inside `AgentWorkGroupView` and pass it to `CollapseHeader`. Do not introduce a public-share-specific taxonomy.

- [ ] **Step 5: Run focused regression tests and commit**

  ```bash
  pnpm --filter happy-app exec vitest run sources/components/PublicSessionTranscript.test.tsx sources/components/ToolGroupView.test.tsx sources/components/markdown/CodeBlockCopyButton.test.tsx
  git add packages/happy-app/sources/components/PublicSessionTranscript.tsx packages/happy-app/sources/components/PublicSessionTranscript.test.tsx packages/happy-app/sources/components/ToolGroupView.tsx packages/happy-app/sources/components/ToolGroupView.test.tsx
  git commit -m "feat(app): polish public transcript presentation"
  ```

### Task 3: Caddy serves the SPA entry from OSS and permits icon fonts

**Files:**
- Modify: `scripts/configure-production-web-caddy.mjs`
- Modify: `scripts/configure-production-web-caddy.test.mjs`
- Modify: `scripts/verify-web-release.mjs`

**Interfaces:**
- Consumes: canonical OSS host `happy-app-ota-jacky.oss-cn-hangzhou.aliyuncs.com` and stable object `/web/current/index.html`.
- Produces: one idempotent managed Caddy block with backend routes, root-asset redirects, a fixed-path OSS HTML proxy, public-share headers, and no filesystem root.

- [ ] **Step 1: Write failing Caddy behavior tests**

  Transform the existing fixture and assert: `/share/*` is removed from the application backend; the generic SPA handler rewrites to `/web/current/index.html`; the proxy upstream host is fixed; `Content-Disposition` is removed; HTML content type is set; `/_expo/*`, `/assets/*`, and named runtime files redirect to OSS; `font-src` contains the OSS origin; and `/var/www/happy-web`, `root`, and `file_server` disappear from the production site. Preserve the existing idempotence, unrelated-site, and malformed-config tests.

- [ ] **Step 2: Run the Caddy test and verify RED**

  ```bash
  node --test scripts/configure-production-web-caddy.test.mjs
  ```

  Expected: failures for missing OSS proxy, asset redirects, font source, and filesystem removal.

- [ ] **Step 3: Implement the managed routing block**

  Replace the filesystem fallback rather than appending a competing handler. The fixed upstream host and rewritten object path must not contain request-derived data. Keep public-share headers route-scoped and retain Caddy's bounded `10s` grace period.

- [ ] **Step 4: Strengthen the release verifier and verify RED/GREEN**

  Add an `Origin` header when checking cross-origin font objects, identify Ionicons and Octicons from the built `dist/assets` filenames, and require HTTP 200, a font MIME type, and an `Access-Control-Allow-Origin` value covering the canonical origin. Also require live `/` and `/share/public-deployment-probe` HTML to contain the local `.paws-release-revision` value through an injected release meta tag. Run the test fixture first to see the new assertion fail, then update the verifier implementation.

- [ ] **Step 5: Run Caddy tests and commit**

  ```bash
  node --test scripts/configure-production-web-caddy.test.mjs
  git add scripts/configure-production-web-caddy.mjs scripts/configure-production-web-caddy.test.mjs scripts/verify-web-release.mjs
  git commit -m "feat(web): proxy production entry from OSS"
  ```

### Task 4: Immutable OSS upload, atomic current switch, rollback, and guarded cleanup

**Files:**
- Modify: `scripts/upload-web-assets.sh`
- Create: `scripts/upload-web-assets.test.mjs`
- Modify: `scripts/deploy-web.sh`
- Create: `scripts/deploy-web.test.mjs`
- Create: `scripts/merge-web-oss-cors.mjs`
- Create: `scripts/merge-web-oss-cors.test.mjs`
- Create: `scripts/stamp-web-release.mjs`
- Create: `scripts/stamp-web-release.test.mjs`
- Modify: `.github/workflows/web-production-deploy.yml`

**Interfaces:**
- Consumes: `packages/happy-app/dist/.paws-release-revision`, `PAWS_WEB_OSS_BUCKET`, `OSS_UPLOAD_ENDPOINT`, `OSS_ADDRESSING_STYLE`, `PAWS_WEB_ORIGIN`, and the merged `main` source guard.
- Produces: `web/releases/<sha>/...`, Metro-compatible root objects, `web/current/.paws-release-revision`, `web/current/index.html`, optional `web/rollback/<release-id>/...`, and GitHub step output `rollback_prefix`.

- [ ] **Step 1: Write the failing release-stamp test**

  Run the stamping CLI against a temporary `index.html` and revision marker. Assert it rejects a malformed revision, inserts exactly one `<meta name="paws-release-revision" content="<40-char-sha>">` before `</head>`, writes the same SHA to `.paws-release-revision`, and is idempotent. The mutation caught is an HTML entry that cannot be tied to the deployed commit.

- [ ] **Step 2: Implement the release stamp and verify GREEN**

  Keep stamping independent of the build framework: accept `index.html`, marker path, and SHA as CLI arguments; validate the SHA; replace an existing managed meta tag or insert one; and use the same literal revision for both outputs. Invoke it immediately after the production export.

- [ ] **Step 3: Write failing upload-order and metadata tests**

  Execute `upload-web-assets.sh` against a temporary dist and a fake `aliyun` executable. Assert every file is uploaded under `web/releases/<sha>/`, `_expo/` and `assets/` also land at root with immutable caching, mutable root runtime files use revalidation caching, and the release marker must match a 40-character lowercase Git SHA. The mutation caught is returning to a partial asset-only upload.

- [ ] **Step 4: Implement immutable snapshot uploads and verify GREEN**

  Use `aliyun ossutil cp` with explicit content type/cache metadata. Upload the immutable snapshot before compatibility paths and finish by `stat`-verifying release `index.html` and marker. Never upload credentials or enable OSS website mode.

- [ ] **Step 5: Write failing CORS merge tests**

  Feed the merger: an existing wildcard GET/HEAD rule, a list of unrelated rules, and an empty configuration. Assert a covering rule is reused, unrelated rules remain byte-equivalent after normalization, and only the missing canonical GET/HEAD rule is added. The mutation caught is `PutBucketCors` replacing existing rules.

- [ ] **Step 6: Implement and verify the CORS union**

  Normalize OSS's singular-object and array JSON shapes, preserve `ResponseVary`, emit the full union, and report `changed` or `unchanged`. Have the workflow read current rules and call `put-bucket-cors` only for `changed`; then read back and verify coverage before uploading Web files.

- [ ] **Step 7: Write failing atomic-switch and rollback tests**

  Run `deploy-web.sh` with fake `git`, `pnpm`, and `aliyun` commands plus a temporary dist. Assert command order is: back up existing current marker/index, copy candidate marker, copy candidate index last. Force the final copy to fail and assert the previous marker is restored. Exercise `--rollback <prefix>` and assert it restores marker first and index last. The mutation caught is a partially advanced current entry.

- [ ] **Step 8: Replace SSH dist installation with the OSS switch and verify GREEN**

  Retain canonical-origin, clean-main, exact-revision, and build guards. Remove archive, `scp`, tar extraction, and server-directory switching. Copy only already-verified immutable OSS objects into `web/current`, expose the rollback prefix through `$GITHUB_OUTPUT`, and keep the HTML copy as the final commit point.

- [ ] **Step 9: Reorder and harden the production workflow**

  Order jobs as build → CORS union → immutable upload/verification → OSS current switch → Caddy validate/reload → canonical live verification → exact legacy cleanup. Give the Caddy backup a commit-specific path. Add an `if: failure()` rollback step that restores OSS current and the previous Caddyfile when those backups exist. Cleanup must require the exact path `/var/www/happy-web`, prove the active Caddyfile contains no reference to it, remove only that directory and siblings matching `/var/www/happy-web.backup-*`, and run only after live checks pass.

- [ ] **Step 10: Run release-script tests and commit**

  ```bash
  node --test scripts/stamp-web-release.test.mjs scripts/upload-web-assets.test.mjs scripts/deploy-web.test.mjs scripts/merge-web-oss-cors.test.mjs scripts/configure-production-web-caddy.test.mjs
  git add scripts/stamp-web-release.mjs scripts/stamp-web-release.test.mjs scripts/upload-web-assets.sh scripts/upload-web-assets.test.mjs scripts/deploy-web.sh scripts/deploy-web.test.mjs scripts/merge-web-oss-cors.mjs scripts/merge-web-oss-cors.test.mjs .github/workflows/web-production-deploy.yml
  git commit -m "feat(web): deliver static releases exclusively from OSS"
  ```

### Task 5: One-to-one public-share E2E and visual evidence

**Files:**
- Modify: `packages/happy-app/e2e/public-session-sharing-evidence.spec.ts`
- Create artifacts under: `/Users/jacky/jacky-github/happy--share-page-oss/artifacts/public-share-oss/`

**Interfaces:**
- Consumes: existing `PUBLIC-SESSION-SHARE` server fixture and evidence environment variables.
- Produces: matching 1440-by-900 Before/After PNGs, a final MP4, and direct assertions for Cases SHARE-UI-001 through SHARE-UI-004.

- [ ] **Step 1: Extend the E2E fixture and write failing assertions**

  Include a fenced code block in the public assistant output. Assert the 22 px heading, visible chat/clock/work/chevron/scroll icons, keyboard focus on `markdown-code-copy`, exact clipboard text, copied live feedback, and reset after 1.8 seconds. Inspect `document.fonts` and the loaded font resources so empty vector glyphs fail the Case instead of passing on wrapper dimensions.

- [ ] **Step 2: Capture/replay the Before state**

  Use base revision `b816a12f` at 1440-by-900 with `HAPPY_PUBLIC_SHARE_EVIDENCE_PHASE=before`. If the local E2E environment cannot replay the base, use the supplied screenshots only as supplemental context and report the exact blocker rather than fabricating a matching image.

- [ ] **Step 3: Run focused unit, type, and E2E verification**

  ```bash
  pnpm --filter happy-app exec vitest run sources/components/markdown/CodeBlockCopyButton.test.tsx sources/components/PublicSessionTranscript.test.tsx sources/components/ToolGroupView.test.tsx
  pnpm --filter happy-app exec tsc --noEmit
  HAPPY_PUBLIC_SHARE_EVIDENCE_PHASE=after HAPPY_PUBLIC_SHARE_EVIDENCE_DIR=/Users/jacky/jacky-github/happy--share-page-oss/artifacts/public-share-oss pnpm test:e2e:web -- public-session-sharing-evidence.spec.ts
  ```

  Require all four UI Cases to pass and retain Playwright's final video.

- [ ] **Step 4: Verify dark-theme interaction states**

  Run the public page in `ginghamDark`, inspect normal/hover/copied/failed controls and the neutral header, then capture the required non-default-theme After image.

- [ ] **Step 5: Commit the E2E contract**

  ```bash
  git add packages/happy-app/e2e/public-session-sharing-evidence.spec.ts
  git commit -m "test(web): cover public share interactions"
  ```

### Task 6: Independent gates, preview delivery, and PR

**Files:**
- Modify only confirmed defects found by reviewers.
- Update: `.github/pull_request_template.md` content through the PR body, without deleting its Visual evidence section.

**Interfaces:**
- Consumes: final diff, fresh test logs, Case table, Before/After PNGs, MP4, and infrastructure verification logs.
- Produces: independent `pass/fail/blocked` verdicts, sent Happy media cards, preview OTA metadata if publishing succeeds, and a rendered GitHub PR URL.

- [ ] **Step 1: Run the full proportional verification set**

  Run focused Vitest, all Web script tests, happy-app typecheck, `git diff --check`, and the OTA runtime contract test. Build a production Web export and run the release verifier against an isolated local fixture; do not deploy the feature branch to `8443`.

- [ ] **Step 2: Request independent code review**

  Give the reviewer the approved Spec, implementation plan, final diff, and test evidence. Require one verdict per UI Case and OSS Case. Fix only confirmed issues, then rerun affected tests and downstream gates.

- [ ] **Step 3: Run PC interaction review in regression mode**

  Review discovery, hover/focus/activation feedback, the 1.8-second reset, layout alignment, icon visibility, keyboard operation, and `ginghamDark`. Record one verdict per SHARE-UI Case.

- [ ] **Step 4: Deliver visual artifacts through Happy**

  Validate PNG dimensions and MP4 codec/decoding, inspect for secrets, then call `mcp__happy__send_image` for final screenshots and `mcp__happy__send_file` for the MP4. Record `sent` only after those calls succeed.

- [ ] **Step 5: Publish the standard preview OTA if compatible**

  From `packages/happy-app`, run `pnpm ota:selfhost:preview` only after all local gates and a feature commit. Record channel `preview`, runtime `22`, update UUID, timestamp, and manifest URL. This is App preview delivery, not Web production deployment.

- [ ] **Step 6: Push and create the PR**

  Push `feat/share-page-oss`, create a PR to `main`, declare `Visible UI cases: 4`, and add four `Case → problem → Before → After` rows using immutable commit-SHA image URLs. Include independent review, E2E, interaction review, MP4 delivery, OSS command evidence, and remaining production-migration risk.

- [ ] **Step 7: Open and verify the real PR**

  Confirm the PR body, all four image pairs, links, checks, and head SHA render correctly. Return the PR URL without merging; merge and production deployment require a separate explicit user decision.
