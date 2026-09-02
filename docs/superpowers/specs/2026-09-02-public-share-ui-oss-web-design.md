# Public Share UI and OSS-Only Web Delivery Design

## Summary

Paws will polish the anonymous public-session share page and move the production Web build off the application server's filesystem. The public page will use a restrained, Notion-like document header, provide inline copy confirmation, and restore the missing vector icons. Production Web artifacts will live in Alibaba Cloud OSS; Caddy will retain only routing, security headers, and API proxy responsibilities.

The canonical origin remains `https://47.115.228.20:8443`. This change does not introduce another public Web origin, a temporary tunnel, or a branch preview deployment. It is delivered through the existing merge-to-`main` production workflow.

## Evidence and Root Causes

The current production page and repository establish three independent defects:

1. `MarkdownView` copies code successfully and then calls `Modal.alert`. The anonymous share route does not mount the authenticated `ModalProvider`, so the feedback path logs an initialization error and renders no visible success state.
2. Expo vector icons are emitted as font assets. Caddy redirects `/assets/.../*.ttf` to OSS, while the share-page CSP permits fonts only from `'self'` and `data:`. The OSS font response also lacks an `Access-Control-Allow-Origin` header. The paw mark, tool chevrons, tool category icons, and scroll-to-bottom arrow therefore render as empty space.
3. CI uploads `_expo`, `assets`, and several root files to OSS, but `scripts/deploy-web.sh` still archives and installs the complete `dist` directory under `/var/www/happy-web`. Caddy serves the SPA entry from that directory, so the production server still stores a duplicate Web release.

## Scope

### Goals

- Give the anonymous share page a document-oriented header aligned with the transcript column.
- Replace modal-based code-copy confirmation with an inline `Copy` to `Copied` state.
- Restore all vector icons on the public share page by fixing the complete font delivery contract.
- Show a category icon and disclosure chevron for collapsed agent-work groups.
- Store every production Web artifact, including `index.html` and the release marker, in OSS.
- Remove the production Web `dist` tree from the server after the OSS-backed entry is verified.
- Preserve the canonical origin, share-page security headers, atomic releases, and rollback capability.

### Non-goals

- Redesigning authenticated conversation pages beyond shared component improvements required for correct copy feedback and tool-summary icons.
- Moving public-session attachment authorization into the browser. Shared attachments remain dynamic, share-scoped objects resolved through the public API so revocation continues to take effect immediately.
- Creating a new CDN domain, changing DNS, or replacing the canonical `8443` origin.
- Publishing an unmerged branch to production.

## User-Observable Cases

| Case | Pass condition |
| --- | --- |
| SHARE-UI-001 | The public page header uses a neutral document/chat mark, a clearly readable title, and a clock-labelled publication time aligned with the transcript content. |
| SHARE-UI-002 | A code block copy button shows a copy icon and changes to a check icon plus `Copied` for about 1.8 seconds without opening a modal. |
| SHARE-UI-003 | The header mark, agent-work category icon, disclosure chevron, and scroll-to-bottom arrow are visible on the deployed public page. |
| SHARE-UI-004 | Copy feedback is keyboard accessible, exposes an updated accessibility label, and announces success through a polite live region. |
| WEB-OSS-001 | The production server has no `/var/www/happy-web` release tree after a verified deployment; all Web files are retrievable from OSS. |
| WEB-OSS-002 | `/`, an authenticated SPA route, and `/share/:publicId` return the active OSS-backed `index.html` through the canonical origin. |
| WEB-OSS-003 | Hashed JS, CSS, fonts, and image assets load from OSS with successful responses, correct MIME types, and immutable caching where safe. |
| WEB-OSS-004 | Public share documents retain `no-store`, `noindex`, CSP, `nosniff`, and no-referrer headers. |
| WEB-OSS-005 | A failed upload or verification does not change the active entry; a previous OSS entry can be restored without rebuilding. |

## Share Page Visual Design

The header becomes part of the document column rather than a full-width application bar. A centered inner frame uses the same maximum width as the transcript. It has comfortable top and bottom padding, a subtle bottom divider, and no saturated brand tile.

The leading mark is a 36-by-36 semantic surface with a hairline border and a monochrome `chatbubble-ellipses-outline` glyph. The title uses a 22-pixel semibold treatment with a 28-pixel line height. Publication metadata sits below at 12 pixels, using the secondary text color and a small clock icon. All colors come from current Unistyles semantic tokens, including hover, pressed, success, border, and surface states.

The code-block action remains in the upper-right corner. Its resting state contains `copy-outline` and the localized copy label. After a successful clipboard write, it remains visible, changes to `checkmark`, displays the localized copied label, and uses the theme success color for 1.8 seconds. A failed write displays a short inline error state rather than depending on a global modal.

Agent-work groups pass their computed summary category into the existing collapse header. This enables the same small category glyph already used by nested tool groups. The disclosure chevron stays visible at the end of the label. The scroll-to-bottom button keeps its compact round shape but gains an explicit accessible label and a verified contrasting icon.

## Component Boundaries

### `PublicSessionTranscript`

Owns only public-page framing and header presentation. It continues to adapt snapshots into the shared, read-only transcript. It does not mount authenticated providers or add mutation actions.

### Markdown code-copy action

Owns its local clipboard state and timer. The state machine is `idle -> copied -> idle` or `idle -> failed -> idle`. Cleanup clears the timer when the code block unmounts. The action is reusable on authenticated and public pages because it has no global provider dependency.

### Agent-work collapse header

Receives the existing computed tool-summary category. Icon selection remains centralized in `ToolSummaryIcon`; no public-page-only tool taxonomy is introduced.

### Web release scripts

`upload-web-assets.sh` uploads a complete release snapshot to an immutable prefix keyed by commit SHA and also publishes the hashed objects at the root paths required by the exported bundle. It applies metadata appropriate to each file class. `deploy-web.sh` validates that the local build matches `origin/main`, verifies the immutable release, stages the OSS `current` revision marker, and switches `web/current/index.html` last as the single release commit point. It no longer archives or installs `dist` on the server.

`configure-production-web-caddy.mjs` replaces the filesystem SPA handler with an OSS upstream handler for the stable current entry. It keeps API routes on `localhost:3005`, keeps static asset redirects to OSS, strips OSS's attachment disposition from the proxied HTML response, sets an HTML content type, and preserves the stricter public-share headers.

## OSS Object Layout

The existing Web OSS bucket remains the deployment target to avoid adding an unprovisioned credential boundary. Objects are separated by purpose:

- `web/releases/<commit>/index.html`
- `web/releases/<commit>/.paws-release-revision`
- The remaining release files under the same immutable `web/releases/<commit>/` snapshot
- `web/current/index.html`
- `web/current/.paws-release-revision`
- Existing hashed `_expo/` and `assets/` object paths required by the exported bundle
- Existing root runtime objects such as `canvaskit.wasm`, `favicon.ico`, and `metadata.json`

Immutable release objects are uploaded first. Hashed files are additionally uploaded at the bundle-required root keys with immutable caching; this compatibility copy is necessary because Metro's exported URLs are root-relative. The current marker and entry are copied only after every referenced object passes a HEAD/GET check. The marker is staged first and `web/current/index.html` is copied last, making the HTML object update the single release commit point. The active revision is also embedded in the HTML and must agree with the staged marker during post-switch verification. Previous immutable entries remain available for rollback and are not deleted by the normal deployment.

## Font, CSP, and CORS Contract

The deployment reads the Bucket's existing CORS rules, merges one narrowly scoped rule for anonymous `GET` and `HEAD` of Web assets from the canonical Web origin, writes the union, and reads it back for verification. It never replaces unrelated Bucket rules. The Web rule exposes only cache-validation headers needed by the browser and does not make private session-share attachment prefixes listable.

The public-document CSP adds the OSS Web origin to `font-src`. Existing script allowance remains scoped to the same OSS origin. The deployment verifier requests at least Ionicons and Octicons through the canonical asset path, follows the redirect, and asserts HTTP 200, a font MIME type, and a matching CORS response.

## Caddy Data Flow

1. `/v1/*`, `/v3/*`, `/v4/*`, and `/files/*` continue to proxy to the application server.
2. `/share/*`, `/session/*`, and other SPA routes resolve to the OSS `web/current/index.html` object through Caddy while preserving the browser-visible canonical origin.
3. `/_expo/*`, `/assets/*`, and named root runtime objects redirect to their OSS objects.
4. Caddy applies public-share document security headers after selecting the share route.
5. No route uses `/var/www/happy-web` after the transition.

## Deployment and Rollback

The merge-to-main workflow performs the following ordered gates:

1. Build from the exact merged `main` revision.
2. Upload the immutable OSS release and static asset objects.
3. Verify all references, font CORS, MIME types, and the immutable release marker.
4. Validate the OSS-backed Caddy configuration. On the first migration, stage and verify the candidate under `web/current/` before activating that configuration so the route never points at a missing object. On later releases, the already-active configuration continues serving the previous current entry during validation.
5. Stage the verified marker, switch `web/current/index.html` last, and then install or reload Caddy if the validated configuration changed. If validation or reload fails during the first migration, restore the previous Caddyfile; if a later switch or reload fails, restore the previous current marker and entry, with the entry copied last.
6. Verify the canonical origin, the public share SPA route, security headers, active commit, and representative assets.
7. Remove the exact legacy `/var/www/happy-web` tree and its release backups only after the live checks pass and the active Caddyfile no longer references that root.

Rollback stages a selected immutable release's marker and then copies its entry back to `web/current/index.html` as the final commit point before rerunning the same origin and route verifier. It does not require SSH file restoration.

## Failure Handling

- Clipboard failure produces a local failed state and never reports success.
- Missing icon fonts fail the deployment verifier rather than silently publishing blank controls.
- Partial OSS uploads never advance `web/current`.
- Caddy configuration failures restore the previous file before reload completes.
- A failed post-switch verification restores the previous OSS current entry and marker.
- Legacy server files are never deleted before the new entry, fonts, routes, and revision all pass live verification.

## Testing

### Unit and component tests

- Add a focused code-block copy test that observes the transition from copy to copied and timer cleanup, starting with a failing test.
- Extend `PublicSessionTranscript.test.tsx` to assert the new header structure and semantic icon names.
- Extend tool-group tests to assert the agent-work category icon and chevron.
- Extend Caddy configurator tests to assert OSS entry proxying, static redirects, CSP font allowance, idempotence, and absence of the filesystem root.
- Add release-script tests using a fake `aliyun`/SSH environment to assert upload-before-switch, failure atomicity, and exact legacy cleanup guards.

### Integration and E2E

- Reuse the existing public-session-sharing Playwright path and add direct assertions for visible icons and inline copy feedback.
- Capture Before and After at the same 1440-by-900 viewport and in the required non-default dark theme.
- Record the final passing copy and scroll interaction as a short MP4 and send the screenshot/video through Happy's media delivery tools.
- Run the production release verifier against an isolated fixture before merge. Production deployment itself remains merge-to-main CI only.

## Security and Privacy

- The anonymous page remains read-only and does not acquire authenticated providers.
- Public document and attachment responses remain `no-store` and non-indexable.
- OSS CORS applies only to browser-readable Web assets; it does not expose storage credentials or make private prefixes enumerable.
- Shared attachments continue to be resolved by opaque `publicId + attachmentId` through the API, preserving revocation and filename sanitization.
- The Caddy OSS proxy accepts only a fixed bucket host and fixed current-entry object path; request paths cannot select arbitrary upstream objects.

## Acceptance and Delivery

All five user-visible UI/behavior cases require matching Before/After evidence in the PR. The OSS cases require command output and HTTP header evidence rather than screenshots. The PR may be created only after focused tests, type checking, independent code review, the public-share E2E, and the PC interaction review pass. Merge and production deployment are separate follow-up actions unless explicitly requested.
