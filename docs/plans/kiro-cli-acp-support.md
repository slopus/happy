# Kiro CLI ACP support plan

## Sources captured locally

The source material for this change is stored under `docs/references/kiro-cli/`:

- `kiro-cli-acp.html` / `kiro-cli-acp.txt`: official Kiro CLI ACP docs from `https://kiro.dev/docs/cli/acp/`.
- `kiro-cli.html` / `kiro-cli.txt`: official Kiro CLI overview from `https://kiro.dev/cli/`.
- `kiro-cli-1-25-acp.html` / `kiro-cli-1-25-acp.txt`: official Kiro CLI 1.25 changelog announcing ACP support.
- `zed-kiro-cli-acp.html`: Zed ACP agent listing for Kiro CLI.
- `sample-kiro-acp-ui-README.md`: AWS sample ACP UI README.
- `sample-acp-bridge-README.md`: AWS sample ACP bridge README.
- `local-kiro-cli-help.md`: locally captured `kiro-cli --help`, `kiro-cli --help-all`, `kiro-cli acp --help`, and `kiro-cli --version`.
- `kiro-cli-models.txt`: Kiro CLI model list and Happy model ID mapping from `https://kiro.dev/docs/cli/models/`.

## Facts from the docs and local CLI

- Kiro CLI supports Agent Client Protocol through `kiro-cli acp`.
- Local `kiro-cli` is version `2.11.0`.
- `kiro-cli acp --help` exposes:
  - `--agent <AGENT>`
  - `--model <MODEL>`
  - `--effort <EFFORT>`
  - `--trust-all-tools`
  - `--trust-tools <TOOL_NAMES>`
  - `--agent-engine <ENGINE>` with `v2` default and `v1`/`v3` alternatives
  - `--verbose`
- The official docs and samples describe ACP as JSON-RPC over stdio, which matches Happy's existing generic ACP runner.
- Runtime probing on 2026-07-05 confirmed Kiro ACP sends several custom JSON-RPC notifications that the stock ACP SDK client does not expose:
  - `_kiro.dev/commands/available`
  - `_kiro.dev/goal/status`
  - `_kiro.dev/session/update`
  - `_kiro.dev/metadata`
  - `_kiro.dev/mcp/server_initialized`
  - `_kiro.dev/subagent/list_update`
- `_kiro.dev/commands/available` includes `/goal` with description `Set a goal with validation criteria for iterative completion` and subcommand `clear`.
- A temporary-directory ACP smoke test successfully ran `/goal create GOAL_DONE.txt containing yes and verify it`; Kiro created the file, verified it, and emitted:
  - `{ "state": "active", "iteration": 0, "maxIterations": 5, "message": "create GOAL_DONE.txt containing yes and verify it" }`
  - `{ "state": "completed", "iteration": 0, "maxIterations": 5, "message": "Goal achieved in 0 iterations" }`
- Kiro ACP returns its model list dynamically. The observed list includes `auto`, `claude-sonnet-5`, `claude-opus-4.8`, `claude-opus-4.7`, `claude-opus-4.6`, `claude-sonnet-4.6`, `claude-opus-4.5`, `claude-sonnet-4.5`, `claude-sonnet-4`, `claude-haiku-4.5`, `deepseek-3.2`, `minimax-m2.5`, `minimax-m2.1`, `glm-5`, and `qwen3-coder-next`.

## Existing Happy integration points

Happy already has generic ACP support:

- `packages/happy-cli/src/agent/acp/runAcp.ts`
- `packages/happy-cli/src/agent/acp/acpAgentConfig.ts`
- `packages/happy-cli/src/index.ts` under the `happy acp` command

Current first-class remote spawn support is limited to:

- `claude`
- `codex`
- `gemini`
- `openclaw`

The types and UI that enforce this are currently in:

- `packages/happy-cli/src/modules/common/registerCommonHandlers.ts`
- `packages/happy-cli/src/daemon/run.ts`
- `packages/happy-cli/src/utils/detectCLI.ts`
- `packages/happy-cli/src/api/types.ts`
- `packages/happy-app/sources/sync/ops.ts`
- `packages/happy-app/sources/sync/persistence.ts`
- `packages/happy-app/sources/sync/agentDefaults.ts`
- `packages/happy-app/sources/components/modelModeOptions.ts`
- `packages/happy-app/sources/app/(app)/new/index.tsx`

## Proposed implementation

Use Happy's generic ACP runner rather than writing a Kiro-specific protocol backend. Keep Kiro as a CLI/daemon capability, but do not expose a new Kiro agent in the app UI for now. The immediate product goal is old and new apps behaving the same: users select Claude in the app, while a local daemon setting can route that session to Kiro.

1. Add a first-class `happy kiro` CLI command.
   - It should authenticate and ensure the daemon, then call `runAcp`.
   - It should run command `kiro-cli` with args starting with `acp`.
   - It should pass Kiro-specific CLI flags through to `kiro-cli acp`.
   - It should support `--started-by daemon`, matching other agents.

2. Add `kiro` to known ACP agent resolution.
   - Add `kiro: { command: 'kiro-cli', args: ['acp'] }` to `KNOWN_ACP_AGENTS`.
   - This keeps `happy acp kiro` working as a lower-level escape hatch.

3. Add daemon remote spawn support.
   - Extend spawn agent type unions to include `kiro`.
   - In `daemon/run.ts`, map `options.agent === 'kiro'` to CLI args `kiro --happy-starting-mode remote --started-by daemon`.
   - Tmux and non-tmux spawning should use the same agent mapping.

4. Add CLI availability detection.
   - Detect `kiro-cli` on PATH.
   - Keep `kiro` out of the app's new-session agent picker. The app's agent list is currently compiled into the native bundle, so adding visible Kiro there creates a desktop/iOS mismatch until iOS can be released again.

5. Add a local daemon alias for old apps.
   - Read `agentAliases` from `~/.happy/settings.json`.
   - Support `{ "agentAliases": { "claude": "kiro" } }`.
   - When the app requests `agent: "claude"` and this alias is enabled, spawn `happy kiro` instead of `happy claude`.
   - In alias mode, keep the session flavor compatible with Claude so old iOS and desktop bundles do not need to understand a new `kiro` flavor.
   - Pass a hidden CLI compatibility flag from the daemon to `happy kiro`; direct `happy kiro` usage can still identify as Kiro.

6. Map Claude UI choices when a Claude session is aliased to Kiro.
   - Existing apps send model/permission/effort as message metadata, not as spawn arguments.
   - Kiro should accept complete Kiro/Claude model IDs as-is.
   - Legacy Claude model keys should normalize to Kiro model IDs:
     - `opus` -> `claude-opus-4.8`
     - `fable` -> `claude-sonnet-5`
     - `sonnet` -> `claude-sonnet-4.6`
     - `haiku` -> `claude-haiku-4.5`
     - `default`/`null` -> Kiro default
   - `permissionMode === bypassPermissions` or `yolo` should become Kiro trust-all behavior.
   - In alias mode, start `kiro-cli acp` with trust-all enabled to match the current Claude app default, then still normalize later permission metadata when ACP exposes a mode selector.
   - Effort metadata should be forwarded to Kiro when present.
   - Keep the Happy runner alive after a `happy kiro` cancel. Kiro's ACP process can report `stopped` for a cancelled turn, but the user should still be able to send the next prompt in the same Happy session.

7. Handle Kiro ACP custom notifications before the SDK sees them.
   - The current ACP SDK client rejects Kiro's `_kiro.dev/...` notifications as unknown client methods.
   - Intercept those stdout JSON-RPC lines in `AcpBackend` before they reach `ClientSideConnection`.
   - Convert `_kiro.dev/commands/available` to Happy's existing `available_commands` event, normalizing command names from `/goal` to `goal` so the app autocomplete stays consistent.
   - Convert `_kiro.dev/goal/status` to Happy `AgentGoalStatus`.
   - In Claude alias mode, publish Kiro goal state as `source: "claude"` and write the ACP session id into `metadata.claudeSessionId`; this lets old desktop and iOS clients show the existing goal bar without a new app bundle.
   - Filter unhandled Kiro-only notifications such as `_kiro.dev/session/update` after logging, so the SDK does not emit `Method not found` errors.

8. Add Kiro goal actions.
   - Register the existing `goal-action` RPC for Kiro sessions.
   - Map clear to `/goal clear`.
   - Map edit/set to `/goal <objective>`.
   - Queue those commands as isolated messages and resolve when `_kiro.dev/goal/status` confirms the expected active/inactive state.

9. Update user-facing docs.
   - Update root `README.md` and `packages/happy-cli/README.md` to list `happy kiro` as a CLI command.
   - Document the local Claude-to-Kiro alias for deployments where the installed app cannot be updated.
   - Keep implementation notes in this plan doc.

## Test plan

- Unit tests:
  - `packages/happy-cli/src/agent/acp/acpAgentConfig.test.ts`
  - add/update tests for Kiro ACP mapping.
  - add targeted tests for Kiro command parsing if a separate command parser is introduced.
  - add targeted tests for Claude-to-Kiro alias resolution and legacy Claude model normalization.
  - add targeted tests for Kiro custom ACP notification parsing, including slash commands and goal status state mapping.
  - add `runAcp` tests for updating agent goal state and handling `goal-action`.
- Type checks/builds:
  - `pnpm --filter happy typecheck`
  - `pnpm --filter happy build`
- Local smoke:
  - `happy kiro --help` should route through Happy's help or Kiro ACP help as designed.
  - `happy acp kiro --verbose` should resolve to `kiro-cli acp --verbose`.
  - Cancelling a Kiro turn and sending a follow-up prompt should keep the Happy session responsive.
  - With `agentAliases.claude = "kiro"`, starting a Claude session from the app should ask the daemon to spawn `happy kiro`.
  - Without the alias, starting a Claude session should still spawn `happy claude`.

## Push plan

Before pushing:

1. `git fetch origin main`
2. Rebase the working branch on `origin/main`
3. Re-run the targeted checks after rebase
4. Push the branch to the user's GitHub remote
