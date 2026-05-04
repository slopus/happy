# Fix Verification

Scope: follow-up fixes for the verified warnings in `06-verification-report.md`.

## Fixed Warnings

### Fresh local Codex exits are masked by thread discovery

Fixed in `packages/happy-cli/src/codex/codexLocalLauncher.ts`.

The native launcher now treats child exit as a terminal race result. If Codex exits before session discovery succeeds, Happy returns the native exit code immediately instead of waiting for discovery timeout and throwing a discovery error.

Regression coverage:

- `packages/happy-cli/src/codex/codexLocalLauncher.test.ts`: `returns the native exit code when a fresh launch exits before discovery`

### Native local Codex bypasses configured Happy sandbox

Fixed in `packages/happy-cli/src/codex/runCodex.ts` and `packages/happy-cli/src/codex/codexLocalLauncher.ts`.

`runCodex` now passes the configured `sandboxConfig` to the native local launcher. When sandboxing is enabled on non-Windows platforms, the launcher initializes the Happy sandbox, wraps the native `codex` command with the sandbox transport wrapper, and cleans up the sandbox after the local process finishes.

Regression coverage:

- `packages/happy-cli/src/codex/runCodexLocal.test.ts`: `passes configured Happy sandbox settings to native Codex`
- `packages/happy-cli/src/codex/codexLocalLauncher.test.ts`: `wraps native Codex in the configured Happy sandbox`

### Local Codex default can fail on Windows npm installs

Fixed in `packages/happy-cli/src/codex/codexLocalLauncher.ts`.

The native local launcher now uses `cross-spawn`, matching the existing app-server launcher behavior for npm shim resolution.

### Discovery failures are not surfaced as actionable Happy session errors

Fixed in `packages/happy-cli/src/codex/runCodex.ts`.

The initial local launch path now catches launcher failures, emits a session message that starts with `Codex local launch failed:`, sets a non-zero exit code, and then closes the Happy session through the existing cleanup path.

Regression coverage:

- `packages/happy-cli/src/codex/runCodexLocal.test.ts`: `surfaces native Codex discovery failures as Happy session messages`

### Enriched command results may change compact mobile rendering

Fixed in `packages/happy-app/sources/sync/typesRaw.ts`.

Session-protocol `tool-call-end` normalization now keeps compact rendering stable by leaving normalized `tool-result.content` as `null` and `is_error` as `false`, while preserving the richer payload on the additive `result` field for future rendering work.

Regression coverage:

- `packages/happy-app/sources/sync/typesRaw.test.ts`

## Verification Commands

Passed:

```sh
pnpm --filter happy exec vitest run src/codex/codexLocalLauncher.test.ts src/codex/runCodexLocal.test.ts
pnpm --filter happy-app exec vitest run sources/sync/typesRaw.test.ts
pnpm --filter happy exec vitest run src/commands/codexCommand.test.ts src/codex/cliArgs.test.ts src/codex/modeLoop.test.ts src/codex/codexLocalLauncher.test.ts src/codex/codexThreadDiscovery.test.ts src/codex/runCodexLocal.test.ts src/codex/resumeExistingThread.test.ts src/codex/codexAppServerClient.test.ts src/codex/__tests__/sessionProtocolMapper.test.ts src/sessionProtocol/types.test.ts src/ui/ink/CodexDisplay.test.ts
pnpm --filter happy-app exec vitest run sources/sync/typesRaw.test.ts sources/sync/modeHacks.test.ts
pnpm --filter @slopus/happy-wire exec vitest run src/sessionProtocol.test.ts
pnpm --filter @slopus/happy-wire build
pnpm --filter happy exec tsc --noEmit
pnpm --filter @slopus/happy-wire build && pnpm --filter happy-app typecheck
pnpm --filter happy exec vitest run src/codex/codex.integration.test.ts --project integration-empty
git diff --check
```

Note: an earlier `happy-app` typecheck failed while running concurrently with the `@slopus/happy-wire` build. The sequential wire build plus app typecheck passed.
