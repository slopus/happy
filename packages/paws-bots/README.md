# Paws Bots workspace

Vendored from [elie222/rakazo](https://github.com/elie222/rakazo), commit
`c71c0c6bb6f00e511ece8fa6a919d282c129bbd3`, under Apache-2.0. Upstream copyright,
LICENSE and NOTICE are retained. Paws modifications add a host mount/transport,
scoped styles, account storage isolation, portal containers, and chrome-use for
its explicitly authorized isolated computers. This is a maintained source import,
not a git submodule or a separately downloaded application.

- `apps/web`: original application and reusable `src/paws/entry.ts` mount API.
- `apps/api`, `apps/worker`: original server and inference runtime.
- `packages/*`: original contracts, core, adapters, UI, storage and translations.
- `infra/sandboxes`: isolated Linux desktop and its private supervisor.

These packages participate in Happy's pnpm workspace and its one root lockfile.
The imported workspace supports Web/API/worker/Docker; upstream Electron/mobile
applications were not imported. Retained references to other upstream deployment
providers are not Paws support commitments. Happy root instructions govern edits.

Build Web's mountable bundle with `pnpm bots:build`. For Expo development, use
`node scripts/build-bots-web.mjs --dev` from Happy's root before starting Web.
`pnpm --filter happy-app export:web` builds and integrates immutable, hashed Bots
assets into Paws' release HTML. It mounts a React root in the same document;
MemoryRouter leaves Expo's URL intact, and all Bots selectors/portals stay in the
host container. Its dependencies deduplicate React inside the Bots bundle while
keeping Paws' own React version independent.

The host passes a short-lived one-use launch ticket. Only the lease returned by
redemption reaches the Bots transport. It does not patch host fetch, cookies or
storage, register a Service Worker, or read the Paws bearer. Leaving Bots aborts
in-flight requests and revokes that mount's lease. A fresh bundle instance on
re-entry owns fresh module state. Drafts and internal routes persist by native
space/account, not by a global active-account key.

The Docker source build uses the pinned upstream Linux dependency layer and
rebuilds API/worker from this checked-in revision. See
`integrations/rakazo/Dockerfile.monorepo` and `compose.monorepo.yml`. Computers use
Chromium on Linux/Xvfb/Fluxbox (not ChromiumOS) with view/control leases and the
native noVNC relay. The supervisor alone holds Docker's socket; it is not exposed
on a host/public port, and computers do not receive that socket or arbitrary host
folders. This overlay explicitly enables computers. The original core-only stack
still keeps them disabled.

The native mobile WebView remains separate; its device behavior is not established
by Web or Docker tests. Third-party OAuth, external sends and purchase operations
are not authorized by the presence of their upstream UI.
