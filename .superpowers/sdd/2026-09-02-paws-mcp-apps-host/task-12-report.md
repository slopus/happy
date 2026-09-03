# Task 12 report — isolated MCP App sandbox endpoint

Commit message: `feat(server): serve isolated MCP App sandbox`

## Delivered

- Added fail-closed origin/configuration helpers for `HAPPY_MCP_APP_SANDBOX_ORIGIN` and comma-separated `HAPPY_MCP_APP_PARENT_ORIGINS`. Sandbox Host, requested parent, and request Host are normalized and matched exactly; the parent must remain a different origin.
- Added canonical base64url CSP metadata handling with only `connectDomains`, `resourceDomains`, and `frameDomains`, an 8 KiB encoded ceiling, 32-origin category ceilings, deduplication, strict HTTPS production origins, and development-only loopback HTTP.
- Added exact sandbox-host-only `GET /mcp-app-sandbox/host` and `/mcp-app-sandbox/host.js` routes before static fallback. Invalid/missing configuration, Host, parent, or CSP data returns the same no-store `{ "error": "Not found" }` response.
- Added exact `OPTIONS` deny routes because the server's global wildcard CORS plugin otherwise answered sandbox preflight. Sandbox responses explicitly disable route CORS and remove every `Access-Control-Allow-*` header.
- Extended the existing deterministic Host Shell generator to emit a separate server HTML/external JavaScript asset from the same esbuild bundle while leaving the native inline Host Shell byte-for-byte unchanged.
- The external proxy bootstrap revalidates the exact `parentOrigin`, exact `document.referrer` origin, cross-origin top-window isolation, exact parent `event.source`/`event.origin`, and the 256 KiB bridge ceiling. Every parent-facing `postMessage` uses the validated exact target origin.
- Excluded every unmatched `/mcp-app-sandbox/*` URL from the self-hosted SPA fallback without changing normal Web routes.

## TDD evidence

- Initial RED: both requested suites failed collection because `mcpAppSandboxSecurity` and `mcpAppSandboxRoutes` did not exist (2 failed suites, 0 tests collected).
- Pure helper GREEN: the first security implementation passed 27/27 tests.
- Route/registration RED: the route suite still failed module resolution, and the new SPA exclusion regression failed because `isSpaFallbackExcludedUrl` did not exist.
- CORS self-review RED: the nine-test route suite had 1 failure because global `@fastify/cors` returned `204` for an attacker preflight. Exact deny routes changed it to the required no-store 404 with no allow-origin header.
- Origin normalization RED: the 29-test helper suite had 2 failures because URL parsing normalized `/.` and `/%2e` back to `/`. Raw authority-only validation now rejects both before URL canonicalization.
- Double-origin RED: the 30-test helper suite had 1 failure because an explicitly allowlisted same-origin parent was accepted. Configuration now fails closed if any parent allowlist entry equals the sandbox origin.
- Final focused GREEN: 2 requested files, 40/40 tests. API/static regression adds 4/4 passing tests. Existing native Host Shell suite passes 20/20.

## Exact response contract

HTML 200 responses set:

```text
Cache-Control: no-store
Content-Type: text/html; charset=utf-8
Content-Security-Policy: default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob: <declared resources>; media-src blob: <declared resources>; font-src data: <declared resources>; connect-src <declared connects or 'none'>; frame-src 'self' <declared frames>; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors <exact parent>
Referrer-Policy: no-referrer
X-Content-Type-Options: nosniff
Permissions-Policy: camera=(), microphone=(), geolocation=(), clipboard-write=()
Cross-Origin-Resource-Policy: cross-origin
```

JavaScript 200 responses set `text/javascript; charset=utf-8`, `no-store`, `nosniff`, and `Cross-Origin-Resource-Policy: same-origin`. Neither route emits permissive CORS.

## Generated-asset evidence

- `packages/happy-server/sources/app/api/generated/mcpAppHostShellAssets.ts`: 362,781 bytes, deterministic server HTML plus external JavaScript.
- Generated external JavaScript VM smoke: 350,594 bytes; emitted exactly one `sandbox-proxy-ready` to target `https://paws.example`; installed two Host/proxy listeners; no wildcard parent target.
- `git diff --exit-code 348e985e -- packages/happy-app/sources/components/tools/mcpApps/generated/hostShellBundle.ts`: exit 0. Native output remains 361,233 bytes and unchanged from the Task 12 baseline.

## Verification

```text
pnpm --filter happy-app run build:mcp-app-host-shell
exit 0

pnpm --filter happy-server-self-host exec vitest run sources/app/api/mcpAppSandboxSecurity.spec.ts sources/app/api/routes/mcpAppSandboxRoutes.spec.ts
Test Files  2 passed (2)
Tests       40 passed (40)

pnpm --filter happy-server-self-host exec vitest run sources/app/api/publicShareDocumentSecurity.spec.ts
Test Files  1 passed (1)
Tests       4 passed (4)

pnpm --filter happy-app exec vitest run sources/components/tools/mcpApps/hostShell.test.ts
Test Files  1 passed (1)
Tests       20 passed (20)

pnpm --filter happy-server-self-host typecheck
exit 0

node packages/happy-app/scripts/build-mcp-app-host-shell.cjs --check
exit 0

git diff --check
exit 0
```

## Files changed

- `packages/happy-app/scripts/build-mcp-app-host-shell.cjs`
- `packages/happy-server/sources/app/api/api.ts`
- `packages/happy-server/sources/app/api/publicShareDocumentSecurity.spec.ts`
- `packages/happy-server/sources/app/api/generated/mcpAppHostShellAssets.ts`
- `packages/happy-server/sources/app/api/mcpAppSandboxSecurity.ts`
- `packages/happy-server/sources/app/api/mcpAppSandboxSecurity.spec.ts`
- `packages/happy-server/sources/app/api/routes/mcpAppSandboxRoutes.ts`
- `packages/happy-server/sources/app/api/routes/mcpAppSandboxRoutes.spec.ts`

## Self-review / concerns

- No configuration, allowlist, CSP query, resource URI, HTML payload, connector/account context, or bridge message is logged. Failure bodies and cache headers are deliberately identical.
- Production accepts HTTPS only. Local HTTP works only with `NODE_ENV=development` and exact `localhost`, `127.0.0.1`, or `[::1]`; no implicit test/non-production relaxation exists.
- Canonical CSP JSON has fixed key order and rejects alternate encoding, unknown keys, duplicates that change canonical bytes, paths normalized by `URL`, directive separators, credentials, wildcard hosts, and over-limit input.
- The checked-in native shell is unchanged; the new server asset is additive. Task 13 must consume the emitted `{ type: "sandbox-proxy-ready", parentOrigin }` handshake and keep exact source/origin targeting. Real two-origin browser/Caddy verification remains the Task 14 runtime gate.
- The two pre-existing untracked Task 14 E2E paths remain untouched and are excluded from staging.

## Fix round 1 — namespace logging, complete fallback, and raw loopback authority

### Findings addressed

- Added route-local `logLevel: 'silent'` to both exact GET routes, both exact OPTIONS deny routes, the base namespace catch-all, and the descendant namespace catch-all. This suppresses only sandbox request/completion logging; unrelated API and SPA route logging remains enabled.
- Protected the complete namespace with exact routes first, followed by `app.all('/mcp-app-sandbox')` and `app.all('/mcp-app-sandbox/*')`. Exact GET routes disable Fastify's automatic HEAD exposure so HEAD, POST, PUT, and every other unsupported method reaches the static sandbox 404.
- Every namespace route uses `cors: false`. The shared responder dynamically removes all `Access-Control-Allow-*`, `Access-Control-Expose-Headers`, and `Access-Control-Max-Age` headers before returning `Cache-Control: no-store` plus the static `{ "error": "Not found" }` body.
- Extracted the production Fastify registration into `createApiApp`, which is the exact builder consumed by `startApi`. This allows injection tests to exercise the real global wildcard CORS hook, route ordering, logger, static plugin, and SPA fallback without listening or starting Socket.IO.
- Added a real-API captured-log regression covering valid/invalid exact routes, wrong methods, unknown descendants, and unknown OPTIONS. Captured logs contain no raw parent origin, encoded CSP, internal domain, or sandbox query string; an ordinary conversation route still reaches the configured SPA canary.
- Validated development HTTP before WHATWG normalization. Only literal lowercase `localhost`, `127.0.0.1`, or bracketed `[::1]` with no port or a canonical decimal port from 1–65535 is accepted in configured origins and the request Host. Short/integer/octal/hex IPv4, uppercase/percent spellings, empty/zero/leading-zero/out-of-range ports, userinfo, path, query, and fragment fail closed.
- Applied the same raw development parent-origin rule to the generated Web proxy bootstrap. HTTPS/default-port behavior and the native generated Host Shell remain unchanged.
- Hardened the SPA exclusion helper for the exact base namespace, its query form, and every descendant while preserving normal SPA paths.

### RED / GREEN evidence

- Review RED: the focused helper/route run executed 64 tests with 15 failures and 49 passes: 9 non-canonical development origins were accepted, 5 namespace/CORS requests missed the static response, and captured Fastify logs contained the full parent origin, base64url CSP, internal domain, and query.
- Namespace/log GREEN: after route-local logging and catch-all implementation, helper tests passed 47/47 and route tests passed 16/17. The sole residual was a test assumption that Fastify injection would strip the explicit shared JSON body for HEAD; the expectation was corrected to the route's static response without weakening production behavior.
- Production-builder RED: the real API integration failed 1/1 because `createApiApp` did not exist. GREEN uses the same builder as `startApi`, with global CORS and a live temporary SPA fallback.
- Request-Host RED: the expanded 54-test helper suite had 7 failures because non-canonical raw Host spellings still normalized into loopback. GREEN validates the raw Host before URL parsing and passes 54/54.
- SPA-base RED: the existing four-test API helper suite had 1 failure because `/mcp-app-sandbox?…` was not recognized by the fallback exclusion. GREEN compares the parsed pathname and passes 4/4.
- Final fresh server GREEN: 4 files and 78/78 tests, including 54 pure security, 19 direct Fastify route, 1 production API builder/injection, and 4 static fallback regressions.
- Native Host Shell regression remains 20/20; server typecheck, deterministic generator check, native byte-parity diff, and `git diff --check` pass.

### Self-review / remaining gate

- The sandbox routes contain no explicit logging calls and do not pass request URLs or query data to error messages. The captured production logger test proves ordinary Paws request logging remains active outside this namespace.
- Exact invalid routes and unknown namespace routes have equal status, body, cache-control, content type, and absence of every Access-Control response header.
- The generated server proxy asset changes only to reject non-canonical development HTTP parent origins. The checked-in native Host Shell remains byte-for-byte equal to commit `976e64b8`.
- Regenerated server asset: 362,825-byte TypeScript export / 350,638-byte external JavaScript. VM smoke emits one ready message to exact `https://paws.example` and zero for raw `http://LOCALHOST:8081`.
- Real deployed two-origin browser/Caddy behavior remains the Task 14 gate; no same-origin, wildcard, or permissive logging/CORS fallback was introduced.
- The two pre-existing untracked Task 14 E2E paths remain untouched and excluded from staging.

## Fix round 2 — malformed URL containment before routing

### Finding addressed

- Fastify rejects malformed percent encoding before route matching. A request such as `/mcp-app-sandbox/%zz?parentOrigin=…&csp=…` therefore bypassed the route-local silent logger and shared static 404, allowing the framework's generic 400 response and request logger to echo the raw URL.
- Added a raw, non-decoding namespace boundary helper. It accepts only exact `/mcp-app-sandbox`, its query form, and literal `/mcp-app-sandbox/` descendants. It deliberately rejects `/mcp-app-sandbox-evil`, encoded `%2F` lookalikes, unrelated paths, and empty input.
- The Fastify framework-error hook now checks that literal raw namespace before its generic response and uses the same shared no-store 404 responder as ordinary sandbox routes. The responder dynamically removes every `Access-Control-Allow-*`, `Access-Control-Expose-Headers`, and `Access-Control-Max-Age` header.
- A root `childLoggerFactory` gives only requests inside that raw namespace a silent child logger. This acts before routing, covers malformed URLs, and leaves unrelated request/error logging unchanged. Existing route-local silence remains in place for successfully parsed sandbox requests.

### RED / GREEN evidence

- Real `createApiApp` RED: 1/2 integration tests failed because malformed literal sandbox descendants returned 400 rather than 404.
- Real `createApiApp` GREEN: GET, HEAD, OPTIONS, and POST malformed descendants return the shared 404 contract with `Cache-Control: no-store`, no Access-Control response headers, and no parent-origin/CSP/query material in body or captured logs.
- The same integration proves `/unrelated/%zz`, `/mcp-app-sandbox-evil/%zz`, and `/mcp-app-sandbox%2F%zz` retain Fastify's generic `FST_ERR_BAD_URL` 400 and ordinary captured logging. The guard does not broaden the namespace by decoding or normalization.
- Final server matrix: 6 files, 90/90 tests, including 9 raw-boundary tests, 54 origin/CSP tests, 19 direct route tests, 2 real production-builder tests, 4 SPA/static regressions, and 2 generic error-handler regressions.
- Server typecheck, native Host Shell 20/20, deterministic generator build/check, native and server generated-asset parity against `f270403b`, leak grep, and `git diff --check` all pass.

### Self-review

- The pre-router branch never logs the error or request URL and never serializes the framework error. Its body is the same static object used by invalid exact, wrong-method, base, and unknown descendant routes.
- No wildcard CORS, global logging disable, configuration exposure, URL decoding, or lookalike-prefix match was introduced. The two Task 14 untracked paths remain untouched and excluded from staging.
