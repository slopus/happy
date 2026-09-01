# Session Startup Timeout and CLI Release Implementation Plan

> **Goal:** Prevent healthy slow session starts from failing at 60 seconds while publishing the already-merged daemon ownership fix in a new CLI release.

**Architecture:** Centralize encrypted Socket.IO RPC handling in `ApiSocket`, give ordinary App calls a 60-second default ACK timeout, and let callers override it. The two App operations that create a CLI process pass a 140-second startup timeout. The server forwards ordinary RPCs with a 30-second target timeout and the two startup methods with a 100-second target timeout, leaving the daemon's 90-second internal startup webhook budget below both upstream limits. The App budget covers the initial 2-second lookup, a strictly capped 15-second reconnect grace window, the server's 100-second startup budget, and transport margin. Bump the CLI package to `1.3.0` so the existing main-branch workflow publishes the daemon fix that is already in source.

**Tech Stack:** TypeScript, React Native/Expo, Socket.IO client, Vitest, pnpm, GitHub Actions, npm.

---

## Task 1: Specify the encrypted RPC behavior with failing tests

**Files:**

- Create: `packages/happy-app/sources/sync/apiSocket.test.ts`
- Modify: `packages/happy-app/sources/sync/apiSocket.ts`

1. Add a Socket.IO mock whose `timeout(ms)` returns an acknowledgement emitter.
2. Add a test that a disconnected socket rejects immediately before encryption or emission.
3. Add a test that an ordinary session RPC uses the 60-second default, sends encrypted parameters, and decrypts a valid response.
4. Add a test that a machine RPC accepts a timeout override.
5. Add a test that disconnecting or replacing the socket during encryption rejects without emission.
6. Add tests for server-declared errors, malformed acknowledgements, and Socket.IO timeout rejection.
7. Run `pnpm --filter happy-app exec vitest run sources/sync/apiSocket.test.ts` and confirm the new tests fail for the missing behavior.

## Task 2: Implement the shared bounded RPC path

**Files:**

- Modify: `packages/happy-app/sources/sync/apiSocket.ts`

1. Export a named `DEFAULT_RPC_ACK_TIMEOUT_MS = 60_000` constant and a typed `RpcCallOptions` with optional `timeoutMs`.
2. Add the optional call options to `sessionRPC` and `machineRPC` without changing existing callers.
3. Route both methods through one private encrypted RPC helper.
4. Validate the initial connection, encrypt the request, revalidate socket identity/connection, send with Socket.IO ACK timeout, validate the response envelope, and decrypt only valid success payloads.
5. Run the targeted `apiSocket.test.ts` command and confirm it passes.

## Task 3: Apply the startup-specific timeout through public operations

**Files:**

- Modify: `packages/happy-app/sources/sync/ops.ts`
- Modify: `packages/happy-app/sources/sync/ops.codexFork.test.ts`

1. First update the spawn/resume operation tests to expect a fourth RPC argument containing `timeoutMs: 140_000`.
2. Run `pnpm --filter happy-app exec vitest run sources/sync/ops.codexFork.test.ts` and confirm the expectations fail.
3. Add a named `SESSION_START_RPC_TIMEOUT_MS = 140_000` constant in `ops.ts`.
4. Pass the timeout options only from `machineSpawnNewSession` and `machineResumeSession`; leave ordinary machine and session operations on the default timeout.
5. Run both targeted App test files and confirm they pass.

## Task 4: Apply the server downstream startup budget

**Files:**

- Modify: `packages/happy-server/sources/app/api/socket/rpcHandler.ts`
- Create: `packages/happy-server/sources/app/api/socket/rpcHandler.spec.ts`

1. Add a named startup timeout budget of `100_000` milliseconds and select it from `baseMethodName(method)` only for `spawn-happy-session` and `resume-happy-session`; keep ordinary methods at `30_000` milliseconds.
2. Extend the RPC duration histogram buckets through 60, 90, and 100 seconds so slow startup behavior remains observable.
3. Test target forwarding for ordinary, spawn, and resume methods, including a fake-timer 90-second startup acknowledgement that succeeds before the 100-second target timeout.
4. Cap every reconnect-grace fetch and sleep by the remaining deadline so the initial 2-second lookup plus grace never exceeds 17 seconds total; leave presence polling semantics unchanged.
5. Run the server spec and server build.

## Task 5: Prepare the CLI package release

**Files:**

- Modify: `packages/happy-cli/package.json`
- Modify: `.github/workflows/cli-npm-publish.yml`
- Verify: `packages/happy-cli/src/daemon/controlClient.test.ts`

1. Query npm for `@wangjs-jacky/paws@1.3.0` immediately before editing and confirm the exact version is absent.
2. Change the package version from `1.2.4` to `1.3.0`.
3. Run the daemon ownership regression test to confirm a live PID survives a transient HTTP failure and a dead PID is cleaned up.
4. Update the publish job to run the full `pnpm --filter @wangjs-jacky/paws test` gate, pack the generated tarball, install that tarball into a `mktemp -d` prefix with `--ignore-scripts`, run the installed `.bin/paws --version`, and require output exactly equal to `happy version: <candidate version>` before publish.

## Task 6: Run verification and review the diff

**Files:** all changed files.

1. Run the two targeted App suites and the daemon control-client suite.
2. Run `pnpm --filter happy-app typecheck`.
3. Run `pnpm --filter @wangjs-jacky/paws typecheck` and `pnpm --filter @wangjs-jacky/paws build`.
4. Run `git diff --check`, inspect `git diff --stat`, and confirm the old dirty checkout under `happy-study/happy` is unchanged.
5. Request an independent code review and resolve any correctness findings.

## Task 7: Submit and verify the pull request

**Files:** no additional source files expected.

1. Commit the tested implementation with a code-focused commit message.
2. Push `fix/session-startup-timeout-release` and open a pull request against `main` with the root cause, behavior change, test evidence, and release note.
3. Verify all PR checks and the preview OTA workflow triggered by the App change.
4. Do not merge automatically; report the PR and preview status for approval.

## Task 8: Post-merge release and Macmini2 deployment

1. After merge approval, verify the `CLI npm publish` workflow completes and npm reports `1.3.0`.
2. Verify the repository-required production OTA and Web workflows and report their URLs/status.
3. Install the exact new package on Macmini2 and verify its binary path/version/bundle before touching the daemon.
4. Coordinate a safe daemon restart because active sessions can be affected, then run a real mobile spawn/resume probe under load.
5. Remove the sibling worktree and topic branch only after merge and runtime verification.

## Explicit non-goals

- Do not change `packages/paws-agent`'s independent 30-second realtime transport timeout.
- Do not modify the old dirty checkout at `/Users/jiashengwang/jacky-github/happy-study/happy`.
- Do not publish from the developer machine or print credentials; use the existing GitHub Actions secret/OIDC path.
