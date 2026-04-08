# Vendored sources for `pi-happy`

Snapshot commit: `32ab3bf3446253964a5e54837f2f3b2677b82fd6`

These files were intentionally copied from `happy-cli` because they are session-scoped utilities that are useful to the `pi-happy` extension but are not yet available as a stable shared package.

## Source mapping

- `vendor/invalidate-sync.ts`
  - from `packages/happy-cli/src/utils/sync.ts`
  - adaptation: updated import path to local `vendor/time.ts`
- `vendor/async-lock.ts`
  - from `packages/happy-cli/src/utils/lock.ts`
  - adaptation: none beyond local formatting
- `vendor/time.ts`
  - from `packages/happy-cli/src/utils/time.ts`
  - adaptation: replaced `@/ui/logger` with `vendor/logger.ts`
- `vendor/rpc/types.ts`
  - from `packages/happy-cli/src/api/rpc/types.ts`
  - adaptation: none beyond local formatting
- `vendor/rpc/handler-manager.ts`
  - from `packages/happy-cli/src/api/rpc/RpcHandlerManager.ts`
  - adaptations:
    - replaced `@/ui/logger` with `vendor/logger.ts`
    - replaced `@/api/encryption` with `happy-agent/encryption`
- `vendor/path-security.ts`
  - from `packages/happy-cli/src/modules/common/pathSecurity.ts`
  - adaptations:
    - switched to `path.relative()` so the working-directory boundary check is platform-safe
- `vendor/register-common-handlers.ts`
  - from `packages/happy-cli/src/modules/common/registerCommonHandlers.ts`
  - adaptations:
    - replaced `@/ui/logger` with `vendor/logger.ts`
    - replaced bundled ripgrep/difftastic launchers with optional PATH lookup for `rg` and `difft`
    - removed `@/projectPath` dependency

## Why this is vendored

`happy-agent` already gives `pi-happy` the reusable crypto and API building blocks we need. These utilities are the remaining pieces that are still coupled to `happy-cli` internals today. Vendoring them keeps the MVP moving without pulling in `happy-cli` singletons and path aliases.

## Follow-up intent

Once the integration surface stabilizes, these modules should move into a dedicated shared package (for example `happy-sdk`) so `pi-happy`, `happy-cli`, and future clients can all depend on one maintained implementation.
