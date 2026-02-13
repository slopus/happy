# Add Anthropic Sandbox Runtime to CLI

## Overview
Integrate `@anthropic-ai/sandbox-runtime` into happy-cli to sandbox both **Claude Code** and **Codex** sessions with OS-level filesystem and network restrictions. The sandbox wraps agent subprocesses, enforcing configurable restrictions without requiring containers.

Key features:
- **`happy sandbox configure`** - Interactive CLI wizard (using `inquirer`) to set up sandbox rules
- **`happy sandbox status`** - Show current sandbox configuration
- **`happy sandbox disable`** - Turn off sandboxing
- **Automatic enforcement** - Once configured, sandbox wraps both Claude and Codex sessions by default (bypass with `--no-sandbox`)
- **Global config** - Stored in `~/.happy/settings.json` alongside existing settings
- **Dual agent support** - Same sandbox config applies to both Claude Code and Codex

## Context
- **Claude spawn point**: `packages/happy-cli/src/claude/claudeLocal.ts:241` - `spawn('node', [claudeCliPath, ...args], {env, ...})`
- **Codex spawn point**: `packages/happy-cli/src/codex/codexMcpClient.ts:107` - `StdioClientTransport({ command: 'codex', args: ['mcp-server'], env })` which internally calls `cross-spawn('codex', ['mcp-server'])`
- **Config storage**: `packages/happy-cli/src/persistence.ts` - Settings interface + Zod schemas + atomic `updateSettings()`
- **Command dispatch**: `packages/happy-cli/src/index.ts` - manual `if/else if` routing on `args[0]`
- **Existing command pattern**: `packages/happy-cli/src/commands/connect.ts` - exported `handleXxxCommand(args)` functions
- **Test pattern**: Co-located `.test.ts` files using vitest (e.g., `claudeLocal.test.ts`)

## Sandbox Runtime API
```typescript
import { SandboxManager, type SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime'

const config: SandboxRuntimeConfig = {
  network: {
    allowedDomains: ['*'],      // allow all by default
    deniedDomains: [],
    allowLocalBinding: true,
    allowUnixSockets: [],
  },
  filesystem: {
    denyRead: ['~/.ssh', '~/.aws'],
    allowWrite: ['.', '/tmp'],
    denyWrite: ['.env'],
  },
}

await SandboxManager.initialize(config)
const wrappedCmd = await SandboxManager.wrapWithSandbox('node script.js')
// wrappedCmd is a string with OS-level sandbox wrapping
spawn(wrappedCmd, { shell: true })
await SandboxManager.reset()
```

## Agent Integration Architecture

### Claude Code (direct spawn)
Claude is spawned directly via `spawn('node', [claudeCliPath, ...args])` in `claudeLocal.ts`. We wrap the full command with `SandboxManager.wrapWithSandbox()` and spawn with `shell: true`.

When sandbox is enabled, automatically add `--dangerously-skip-permissions` to Claude's args. The sandbox provides OS-level enforcement, so Claude's built-in permission prompts become redundant friction.

### Codex (MCP SDK spawn)
Codex spawns via MCP SDK's `StdioClientTransport`, which calls `cross-spawn('codex', ['mcp-server'])` internally with `shell: false`. Since we can't modify the SDK's spawn call, we:
1. Initialize `SandboxManager` before creating the transport
2. Get the wrapped command via `SandboxManager.wrapWithSandbox('codex mcp-server')`
3. Pass `command: 'sh'`, `args: ['-c', wrappedCommand]` to `StdioClientTransport` instead of `command: 'codex'`, `args: ['mcp-server']`

This way the MCP SDK spawns `sh -c "<sandbox-wrapped codex mcp-server>"`, which achieves the same OS-level sandboxing.

When sandbox is enabled, force Codex to `approval-policy: 'never'` and `sandbox: 'danger-full-access'`. The OS-level sandbox already enforces restrictions, so Codex's own permission checks become redundant.

### Permission bypass rationale
The sandbox provides a strict OS-level security boundary (filesystem + network). With these hard restrictions enforced at the OS level, the agents' built-in permission prompts are unnecessary - they can only operate within what the sandbox allows. This gives the user a seamless "full auto" experience while maintaining real security.

## Development Approach
- **Testing approach**: Regular (code first, then tests)
- Complete each task fully before moving to the next
- Make small, focused changes
- **CRITICAL: every task MUST include new/updated tests** for code changes in that task
- **CRITICAL: all tests must pass before starting next task**
- **CRITICAL: update this plan file when scope changes during implementation**
- Run tests after each change

## Testing Strategy
- **Unit tests**: Required for every task - Zod schema validation, config resolution, command argument parsing, sandbox config builder logic
- **Integration tests**: Sandbox wrapping in `claudeLocal.ts` and `codexMcpClient.ts` (mock `SandboxManager`)

## Progress Tracking
- Mark completed items with `[x]` immediately when done
- Add newly discovered tasks with + prefix
- Document issues/blockers with warning prefix
- Update plan if implementation deviates from original scope

## Implementation Steps

### Task 1: Add `@anthropic-ai/sandbox-runtime` and `inquirer` dependencies
- [x] Run `yarn add @anthropic-ai/sandbox-runtime inquirer` in `packages/happy-cli`
- [x] Run `yarn add -D @types/inquirer` in `packages/happy-cli`
- [x] Verify packages install and build succeeds

### Task 2: Define sandbox config Zod schema and persistence
- [x] Add `SandboxConfigSchema` to `persistence.ts` with the following shape:
  ```typescript
  const SandboxConfigSchema = z.object({
    enabled: z.boolean().default(false),
    workspaceRoot: z.string().optional(),         // e.g. "~/projects"
    sessionIsolation: z.enum(['strict', 'workspace', 'custom']).default('workspace'),
    // 'strict' = only session cwd, 'workspace' = full workspaceRoot, 'custom' = user-defined paths
    customWritePaths: z.array(z.string()).default([]),  // extra paths for 'custom' mode
    denyReadPaths: z.array(z.string()).default(['~/.ssh', '~/.aws', '~/.gnupg']),
    extraWritePaths: z.array(z.string()).default(['/tmp']),  // always allowed beyond workspace
    denyWritePaths: z.array(z.string()).default(['.env']),   // denied even within allowed dirs
    networkMode: z.enum(['blocked', 'allowed', 'custom']).default('allowed'),
    allowedDomains: z.array(z.string()).default([]),   // for 'custom' network mode
    deniedDomains: z.array(z.string()).default([]),    // for 'custom' network mode
    allowLocalBinding: z.boolean().default(true),      // for dev servers
  })
  ```
- [x] Add `sandboxConfig?: z.infer<typeof SandboxConfigSchema>` to the `Settings` interface
- [x] Add sandbox field to `defaultSettings` (undefined by default)
- [x] Export `SandboxConfig` type and the schema for external use
- [x] Write tests for `SandboxConfigSchema` validation (valid configs, invalid configs, defaults)
- [x] Run tests - must pass before next task

### Task 3: Create sandbox config builder utility
- [x] Create `packages/happy-cli/src/sandbox/config.ts`
- [x] Implement `buildSandboxRuntimeConfig(sandboxConfig, sessionPath)` function that converts our `SandboxConfig` into `SandboxRuntimeConfig`:
  - Resolves `~` in all paths
  - For `sessionIsolation`:
    - `'strict'` → `allowWrite: [sessionPath, ...extraWritePaths]`
    - `'workspace'` → `allowWrite: [workspaceRoot || sessionPath, ...extraWritePaths]`
    - `'custom'` → `allowWrite: [...customWritePaths, ...extraWritePaths]`
  - For `networkMode`:
    - `'blocked'` → `allowedDomains: []` (block all)
    - `'allowed'` → `allowedDomains: ['*']` (allow all)
    - `'custom'` → use `allowedDomains` and `deniedDomains` from config
  - Maps `denyReadPaths` → `filesystem.denyRead`
  - Maps `denyWritePaths` → `filesystem.denyWrite`
  - Maps `allowLocalBinding` → `network.allowLocalBinding`
- [x] Write tests for `buildSandboxRuntimeConfig` covering all isolation modes and network modes
- [x] Write tests for path resolution (tilde expansion, relative paths)
- [x] Run tests - must pass before next task

### Task 4: Create sandbox lifecycle manager
- [x] Create `packages/happy-cli/src/sandbox/manager.ts`
- [x] Implement `initializeSandbox(sandboxConfig, sessionPath)`:
  - Builds runtime config via `buildSandboxRuntimeConfig()`
  - Calls `SandboxManager.initialize(runtimeConfig)`
  - Returns cleanup function that calls `SandboxManager.reset()`
- [x] Implement `wrapCommand(command)`:
  - Calls `SandboxManager.wrapWithSandbox(command)`
  - Returns the wrapped command string
- [x] Implement `wrapForMcpTransport(command, args)`:
  - Calls `SandboxManager.wrapWithSandbox(command + ' ' + args.join(' '))`
  - Returns `{ command: 'sh', args: ['-c', wrappedCommand] }` for use with `StdioClientTransport`
- [x] Write tests for lifecycle manager (mock `SandboxManager`)
- [x] Run tests - must pass before next task

### Task 5: Create `happy sandbox configure` interactive wizard
- [x] Create `packages/happy-cli/src/commands/sandbox.ts`
- [x] Implement `handleSandboxCommand(args: string[])` with subcommand dispatch (`configure`, `status`, `disable`, `help`)
- [x] Implement `handleSandboxConfigure()` using `inquirer` prompts:
  1. **Workspace root**: `input` prompt - "Where is your workspace root? (e.g. ~/projects)" with default `~/projects`
  2. **Session isolation**: `list` prompt - "How should file access be scoped per session?"
     - `strict` - "Only the session directory (most restrictive)"
     - `workspace` - "Full workspace root directory"
     - `custom` - "Let me specify custom paths"
  3. (If `custom`): `input` prompt - "Enter writable paths (comma-separated):"
  4. **Deny read paths**: `checkbox` prompt - "Which sensitive directories should be blocked from reading?" with defaults checked: `~/.ssh`, `~/.aws`, `~/.gnupg`, plus option to add custom
  5. **Extra write paths**: `input` prompt - "Additional writable directories beyond workspace (comma-separated):" with default `/tmp`
  6. **Deny write paths**: `input` prompt - "Files/dirs to deny writing even within allowed areas (comma-separated):" with default `.env`
  7. **Network mode**: `list` prompt - "How should network access be handled?"
     - `allowed` - "Allow all network access (default)"
     - `blocked` - "Block all network access (most secure)"
     - `custom` - "Allow specific domains only"
  8. (If `custom`): `input` prompt - "Enter allowed domains (comma-separated, supports wildcards like *.github.com):"
  9. **Allow localhost**: `confirm` prompt - "Allow binding to localhost ports? (for dev servers)" with default `true`
  10. Show summary of configuration, ask for confirmation
- [x] Save config via `updateSettings()` with `sandboxConfig: { enabled: true, ...answers }`
- [x] Print success message with note about `--no-sandbox` flag
- [x] Write tests for `handleSandboxCommand` argument routing (unit test the dispatch logic)
- [x] Run tests - must pass before next task

### Task 6: Implement `happy sandbox status` and `happy sandbox disable`
- [x] Implement `handleSandboxStatus()` - reads settings, prints formatted sandbox config or "not configured"
- [x] Implement `handleSandboxDisable()` - sets `sandboxConfig.enabled = false` via `updateSettings()`
- [x] Implement `handleSandboxHelp()` - prints usage information
- [x] Write tests for status output formatting and disable logic
- [x] Run tests - must pass before next task

### Task 7: Integrate sandbox into Claude subprocess spawn
- [x] Modify `claudeLocal.ts` to accept `sandboxConfig?: SandboxConfig` in opts
- [x] Before the `spawn()` call (around line 233), if `sandboxConfig` is present and `enabled`:
  1. Call `initializeSandbox(sandboxConfig, opts.path)` to get cleanup function
  2. Append `--dangerously-skip-permissions` to args (sandbox enforces security at OS level, so Claude's permission prompts are redundant)
  3. Call `wrapCommand('node ' + claudeCliPath + ' ' + args.join(' '))` to get wrapped command
  4. Replace `spawn('node', [claudeCliPath, ...args])` with `spawn(wrappedCommand, { shell: true, ... })`
  5. Note: `shell: true` changes stdio behavior - keep `['inherit', 'inherit', 'inherit', 'pipe']` but verify fd3 pipe still works through shell
- [x] Add cleanup: call the cleanup function in the `finally` block after process exits
- [x] Update existing `claudeLocal.test.ts` to cover sandbox wrapping (mock `SandboxManager`)
- [x] Write tests for sandbox initialization, permission bypass, and cleanup lifecycle
- [x] Run tests - must pass before next task

### Task 8: Integrate sandbox into Codex subprocess spawn
- [x] Modify `codexMcpClient.ts` to accept `sandboxConfig?: SandboxConfig` in constructor or `connect()` method
- [x] In `connect()`, if `sandboxConfig` is present and `enabled`:
  1. Call `initializeSandbox(sandboxConfig, process.cwd())` to get cleanup function
  2. Call `wrapForMcpTransport('codex', [mcpCommand])` to get `{ command: 'sh', args: ['-c', wrappedCmd] }`
  3. Use the wrapped command/args in `StdioClientTransport` instead of `command: 'codex', args: [mcpCommand]`
- [x] Add a `sandboxEnabled` flag on `CodexMcpClient` so `runCodex.ts` can check it
- [x] In `runCodex.ts`, when sandbox is enabled, force `approval-policy: 'never'` and `sandbox: 'danger-full-access'` in `startSession()` config (OS-level sandbox enforces security, so Codex's permission prompts are redundant)
- [x] Add cleanup method or handle in `disconnect()` to call `SandboxManager.reset()`
- [x] Write tests for Codex sandbox wrapping and permission bypass (mock `SandboxManager` and `StdioClientTransport`)
- [x] Run tests - must pass before next task

### Task 9: Thread sandbox config through both launch chains
- [x] **Claude chain**:
  - In `claudeLocalLauncher.ts`: accept and pass through `sandboxConfig` to `claudeLocal()`
  - In `runClaude.ts` / `loop.ts`: read `sandboxConfig` from settings, pass through to launcher
- [x] **Codex chain**:
  - In `runCodex.ts`: read `sandboxConfig` from settings, pass to `CodexMcpClient` constructor
- [x] **CLI flags**:
  - In `index.ts`: add `--no-sandbox` flag parsing (sets `options.noSandbox = true`)
  - Apply `--no-sandbox` to both Claude and Codex flows
- [x] **Command registration**:
  - Register `sandbox` command in `index.ts` command dispatch (alongside `auth`, `connect`, etc.)
- [x] Write tests for `--no-sandbox` flag parsing
- [x] Run tests - must pass before next task

### Task 10: Add `happy sandbox` to help text and polish
- [x] Add `happy sandbox` to the help text in `index.ts` (alongside `auth`, `connect`, `daemon`, etc.)
- [x] Add startup message when sandbox is active for both Claude and Codex (e.g., "Sandbox enabled: workspace=~/projects, network=allowed")
- [x] Handle errors gracefully: if `SandboxManager.initialize()` fails, warn user and continue without sandbox
- [x] Handle unsupported platforms (Windows): skip sandbox with warning
- [x] Run tests - must pass before next task

### Task 11: Verify acceptance criteria
- [x] Verify `happy sandbox configure` walks through all questions and saves config (automated command tests)
- [x] Verify `happy sandbox status` shows current config (automated command tests)
- [x] Verify `happy sandbox disable` turns off sandbox (automated command tests)
- [x] Verify Claude launches with sandbox wrapping when configured (claudeLocal sandbox tests)
- [x] Verify Claude gets `--dangerously-skip-permissions` auto-added when sandbox is active (claudeLocal sandbox tests)
- [x] Verify Codex launches with sandbox wrapping when configured (codexMcpClient sandbox tests)
- [x] Verify Codex gets `approval-policy: 'never'` and `sandbox: 'danger-full-access'` when sandbox is active (execution policy tests)
- [x] Verify `--no-sandbox` bypasses sandbox for both agents (and does NOT auto-add permission bypass flags) (flag parsing + fallback tests)
- [x] Verify unconfigured state doesn't affect either agent launch (existing + new non-sandbox tests)
- [x] Verify network defaults to "allowed" (unrestricted) (schema default tests)
- [x] Run full test suite (unit tests)
- [ ] Run linter - all issues must be fixed
- ⚠️ Lint blocker: `packages/happy-cli` has no `eslint.config.*` / `.eslintrc*`, so ESLint 9 cannot run in this package.

### Task 12: Update documentation
- [x] Update README.md if it documents CLI commands
- [x] Update help text to be comprehensive

## Technical Details

### Config resolution flow
```
Settings (persistence.ts)
  → sandboxConfig?: SandboxConfig
    → buildSandboxRuntimeConfig(config, sessionPath)
      → SandboxRuntimeConfig (from @anthropic-ai/sandbox-runtime)
        → SandboxManager.initialize(runtimeConfig)
          → SandboxManager.wrapWithSandbox(command)
```

### Claude launch chain modification
```
index.ts (parse --no-sandbox)
  → runClaude(credentials, options)  // options.noSandbox
    → readSettings() → sandboxConfig
    → loop() → claudeLocalLauncher() → claudeLocal()
      → if sandbox enabled: initializeSandbox() + wrapCommand()
      → spawn(wrappedCommand, { shell: true })
      → finally: cleanup()
```

### Codex launch chain modification
```
index.ts (parse --no-sandbox for codex subcommand too)
  → runCodex({credentials, startedBy, noSandbox})
    → readSettings() → sandboxConfig
    → CodexMcpClient(sandboxConfig)
      → connect():
        → if sandbox enabled: initializeSandbox() + wrapForMcpTransport()
        → StdioClientTransport({ command: 'sh', args: ['-c', wrappedCmd] })
      → disconnect(): cleanup()
```

### Default sandbox preset (after configure)
```json
{
  "enabled": true,
  "workspaceRoot": "~/projects",
  "sessionIsolation": "workspace",
  "denyReadPaths": ["~/.ssh", "~/.aws", "~/.gnupg"],
  "extraWritePaths": ["/tmp"],
  "denyWritePaths": [".env"],
  "networkMode": "allowed",
  "allowedDomains": [],
  "deniedDomains": [],
  "allowLocalBinding": true
}
```

## Post-Completion

**Manual verification:**
- Test `happy sandbox configure` end-to-end on macOS
- Test that Claude Code sessions actually run inside sandbox (try reading `~/.ssh`)
- Test that Codex sessions actually run inside sandbox (try reading `~/.ssh`)
- Test that `--no-sandbox` flag works correctly for both agents
- Verify sandbox doesn't break Claude's PTY/stdin interaction
- Verify sandbox doesn't break Codex's MCP JSON-RPC over stdio
- Test with `shell: true` spawn mode doesn't cause issues with argument quoting
- Verify network is unrestricted by default (can reach any domain)

**Platform considerations:**
- macOS: Uses `sandbox-exec` with Seatbelt profiles (fully supported)
- Linux: Requires `bubblewrap` + `socat` (document prerequisites)
- Windows: Not supported by sandbox-runtime (skip gracefully)
