# Paws Bots

Bots sits immediately below Home in the Paws navigation. It opens the pinned
[Rakazo](https://github.com/elie222/rakazo) application: its own bot list, chat,
groups, mentions, memory, routines, API, worker and PostgreSQL database. Paws is
created as each account's pinned chief bot with native fleet management enabled.
Paws does not implement a second conversation or inference engine.

The former Personal implementation is retired. Its App/profile/runtime code and
CLI command have been removed. Historical Personal sessions, saved configuration,
drafts and pending messages are preserved; old routes lead to Bots and old CLI
commands fail explicitly. They cannot silently resume with a coding agent.

## Runtime and identity

The source revision, official application image and database image are pinned in
[`upstream.lock.json`](../integrations/rakazo/upstream.lock.json). See
[runtime setup](../integrations/rakazo/README.runtime.md) for the native Docker
stack and [gateway setup](../integrations/rakazo/gateway/README.md) for the private
authenticated bridge.

Each authenticated Paws account maps to a separate native Rakazo account and
space. The iframe gets a short-lived, single-use launch ticket. The Paws bearer
token never goes to Rakazo or into the iframe URL. The gateway holds native
sessions privately in memory and validates the account before reusing one.
Changing accounts disposes of the previous frame.

The runtime needs a dedicated root HTTPS origin, separate from the Paws origin.
Its native API/Web listeners remain private. Only the gateway may be exposed by
an operator-managed HTTPS reverse proxy, with exact allowed parent origins.
The Paws server must reach the bootstrap on private loopback; a remote server
requires a separately configured private transport. Running the local Docker
stack does not configure or publish a production deployment.

The default model uses the existing local OpenAI-compatible gateway, with model
ID `codex/gpt-6.1-sol`. This is a local model gateway configuration; this feature
does not download or run GPT model weights on the host.

## Supported boundaries

- Web embedding requires a secure context and Service Worker support. If browser
  isolation cannot start, Bots fails closed and provides an explicit retry.
- Android/iOS WebView code has not passed device acceptance. Web verification
  does not establish native compatibility or offline support.
- Computer provisioning remains disabled (`SANDBOX_PROVIDER=none`). No Docker
  socket, sandbox supervisor or host-shell fallback is enabled by the core stack.
  Native computer browser tooling requires a separate authorized configuration.
- The bridge uses native SSE and browser messages, with one-shot expiry/timeouts;
  it adds no business-state polling. This statement concerns the Bots bridge,
  not every existing Paws or upstream background process.
- Third-party integration screens are upstream UI. OAuth/provider authorization
  through the embedded gateway has not been accepted yet; no existing provider
  account is automatically connected by this feature.

## Verification

```sh
node --test integrations/rakazo/gateway/*.test.mjs integrations/rakazo/stack.test.mjs
pnpm --filter happy-server-self-host exec vitest run sources/bots
pnpm --filter happy-app exec vitest run sources/components/bots \
  sources/components/SidebarView.test.tsx \
  sources/components/SidebarNavigator.test.tsx \
  sources/components/DesktopSidebarSessionsNavigation.test.tsx
```

The full-App fixture in `packages/happy-app/e2e/fixtures/bots/serve.mjs` uses an
isolated Paws database and synthetic accounts, and connects to the actual native
Rakazo services and local GPT gateway. It starts no daemon or computer. Provide
the private `gateway.env` path in `PAWS_BOTS_QA_GATEWAY_ENV` when starting it via
`pnpm exec tsx`; credentials and authenticated URLs are saved only in ignored
private files. Browser acceptance must use the authorized Ego workflow.

## Production ingress

The existing main-only Web deployment configures the dedicated Bots origin at
`https://47.115.228.20:8445`, forwarding to the Mini's private Tailnet ingress.
It reuses the production-web environment's existing verified SSH identity. The
configurator reads the current Caddyfile and its adapted configuration, requires
the existing IP certificate and an unclaimed port, and preserves all other sites.
The native gateway must be running before release activation. Computers remain
explicitly disabled; this ingress does not enable a sandbox provider.

Each deployment uses a run/attempt-specific backup. A later Web failure restores
the Web, Bots, then MCP configuration in reverse preparation order. A transport
failure with an unknown remote outcome requires reading the effective remote
configuration before retrying; the tests do not claim distributed transactions.
