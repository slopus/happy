# MCP App console fixture

Deterministic MCP Apps used to verify Paws across two real browser origins. The
fixture exposes four independent UI resources over Streamable HTTP or stdio:

- release readiness with a mediated approval action;
- a horizontally scrollable and filterable service catalog with health checks;
- a filterable incident board with expandable runbooks and confirmation;
- a deployment planner with environment, step, summary, and preview interactions.

Every resource is a single-file `text/html;profile=mcp-app` bundle. The shared
bundle selects the correct experience from the tool's discriminated structured
content, while every App action calls a real fixture MCP tool through the Host.

The fixture deliberately uses the versions already pinned by `happy-app`:
`@modelcontextprotocol/ext-apps@1.7.5`, MCP SDK `1.29.0`, and esbuild `0.27.2`.
It has no private lockfile or checked-in bundle.

```bash
pnpm --filter happy-app exec tsx e2e/fixtures/mcp-app-console/build.ts
pnpm --filter happy-app exec vitest run \
  --config e2e/fixtures/mcp-app-console/vitest.config.ts
PORT=3107 pnpm --filter happy-app exec tsx e2e/fixtures/mcp-app-console/main.ts
```

For the full local two-origin case, use canonical loopback origins on different
ports: the Paws Web test origin is the parent, while the local Happy Server
origin serves `/mcp-app-sandbox/host`. Configure the test Codex session with the
fixture URL above, set the three required `HAPPY_*MCP_APP*` E2E variables, and
run `mcp-app-host-evidence.spec.ts`. This exercises the production Web adapter,
generated Proxy/Host Shell, official App API, MCP resource, and structured tool
result. Only authentication/session transport may use the existing local E2E
environment; the expected App DOM is never inserted by the harness.

Prepare the readiness call with this deterministic input, then call
`show-service-catalog`, `show-incident-board`, and `show-deployment-planner`
without arguments. The named Web cases can then assert all four exact results:

```json
{
  "releaseName": "Paws MCP Apps Host E2E",
  "checks": [
    { "name": "Protocol metadata preserved", "passed": true },
    { "name": "Structured content preserved", "passed": true },
    { "name": "Different-origin sandbox active", "passed": true },
    { "name": "Mediated actions active", "passed": true }
  ]
}
```

The evidence spec covers nine cases: origin binding, cross-origin isolation,
forged-message rejection, mediated actions, sandbox fallback, each complex App
interaction, and a 430px-wide responsive pass. It must point at a genuine
Codex-backed session containing the four tool results; the harness never
inserts expected App DOM or fabricates tool-call results.

Evidence runs additionally require a clean `HAPPY_E2E_WEB_URL` with no query or
fragment and a protected `0600` Playwright storage-state file supplied through
`HAPPY_E2E_STORAGE_STATE`; the repository ignores
`packages/happy-app/.mcp-app-e2e-auth/`. Authentication bootstrap must run with
recording disabled. This is a deliberate remaining runtime gate, not a passing
local runbook. A local pass would not replace the post-merge production-origin
run.
