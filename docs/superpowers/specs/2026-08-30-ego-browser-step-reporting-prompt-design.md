# Ego Browser Step Reporting Prompt — Technical Design

Date: 2026-08-30
Status: ready for written review
Scope: Happy CLI, Codex and Claude sessions

## 1. Summary

Happy will add a conditional, high-priority instruction that requires Codex and Claude to report each meaningful, completed Ego browser round with a screenshot through the existing `mcp__happy__report_browser_step` tool.

This is intentionally a prompt-driven first version. It does not modify Ego Lite, the bundled `ego-browser` skill, `ego-ops`, the Happy App browser-steps panel, Happy Server storage, or the attachment protocol. It also does not add an adapter, process watcher, command shim, screenshot timer, background queue, or second browser skill.

The implementation reuses the POC transport already merged in PR #379:

1. The agent uses Ego and verifies a meaningful browser round.
2. The agent captures the resulting browser state to a local PNG or JPEG.
3. The agent calls `mcp__happy__report_browser_step({ path, label })` exactly once for that round.
4. Happy CLI encrypts and uploads the image, then emits a file event with `source: "browser_step"`.
5. The existing app projection and right panel render the new step.

The guarantee is behavioral rather than mechanical: Happy strongly instructs the model and reinforces the tool affordance, but cannot guarantee 100% compliance when Ego itself is unchanged.

## 2. Product Contract

### 2.1 User experience

Once a user has installed and onboarded Ego Lite and its skill is discoverable by the selected agent, the user only provides a natural-language browser task. They do not manually invoke MCP, provide screenshot paths, install a second Happy browser skill, or configure an OSS target.

When the agent chooses `ego-browser`, `ego-ops`, or Ego Lite for the task, Happy's injected instruction becomes active. Browser steps then appear in the existing right-side panel as the agent reports them.

### 2.2 Reporting unit

A reportable browser round is one completed and verified Ego execution round that does at least one of the following:

- creates a meaningful visible browser state change;
- reaches a user-recognizable checkpoint;
- extracts or verifies a requested browser result.

The minimum contract is one screenshot and one report at the end of each such round, before the next Ego browser round starts. If one Ego script intentionally contains multiple independently useful checkpoints, the agent may capture and report more than one frame, but it must still report the final verified state.

The following are not separate steps:

- waiting for a page or network idle;
- a retry that does not produce a verified result;
- a tiny scroll used only to reveal the next element;
- a hover, focus change, or other low-level helper call;
- a failed or unverified action.

### 2.3 Labels

Labels are short, user-facing, completed-state descriptions. They describe the observable result rather than the implementation detail.

Good examples:

- `已打开抖音`
- `已进入收藏夹`
- `已提取前 10 个收藏视频`

Bad examples:

- `click @21`
- `等待 500ms`
- `正在尝试进入收藏夹`

### 2.4 Final frame

Before completing or closing the Ego task space, the agent must report the final verified browser state. If no meaningful browser operation succeeded, it must not create a false success frame.

## 3. Prompt Contract

### 3.1 Shared instruction

Happy CLI will define one shared constant named `BROWSER_STEP_REPORTING_INSTRUCTION` in a provider-neutral module:

`packages/happy-cli/src/browser/browserStepReportingPrompt.ts`

Instruction text:

> Whenever you use `ego-browser`, `ego-ops`, or Ego Lite for browser automation, report every meaningful completed and verified browser round to Happy. At the end of the round, before starting the next Ego browser round, capture the current browser view as a PNG or JPEG and call `mcp__happy__report_browser_step` exactly once with the absolute screenshot path and a short completed-state label. Do not report waits, retries, tiny scrolls, low-level helper calls, failed actions, or unverified states as separate steps. Before completing or closing the Ego task space, always report the final verified browser state. If screenshot capture or reporting fails, continue the browser task only when safe, disclose the missing visual step, and never claim that the panel was updated.

The instruction is conditional: it has no effect on sessions that do not use Ego browser automation.

### 3.2 Shared tool description

The module will also export a shared `BROWSER_STEP_TOOL_DESCRIPTION`. Both the direct Happy HTTP MCP registration and the Codex stdio bridge registration will consume the same description so that the model sees a consistent contract regardless of provider path.

The tool description will reinforce, but not duplicate every detail of, the system instruction:

> Report one completed and verified Ego browser round with its current PNG/JPEG screenshot. Call after each meaningful Ego browser round and before the next round; the frame appears in the dedicated browser-steps panel, not normal chat.

The existing schema remains unchanged:

```ts
type BrowserStepInput = {
    path: string;  // absolute PNG/JPEG path
    label: string; // non-empty completed-state label
};
```

## 4. Provider Injection Design

### 4.1 Claude

Claude already receives a Happy-owned append system prompt through `packages/happy-cli/src/claude/utils/systemPrompt.ts`:

- local Claude uses `--append-system-prompt`;
- remote Claude SDK mode combines the user's optional prompt with Happy's `systemPrompt`;
- resumed Claude sessions also receive the Happy append prompt when the process/query starts.

The shared browser reporting instruction will be appended to this existing `systemPrompt`. User-provided `customSystemPrompt` or `appendSystemPrompt` remains supported and is not replaced.

No additional per-turn injection or Claude session state is required.

### 4.2 Codex

Codex currently injects Happy instructions through `buildCodexTurnPrompt()` using internal HTML markers. The session protocol mapper strips those marked sections from user-visible/forked transcript messages.

Browser reporting must have injection state independent from the existing title instruction and user-configured `appendSystemPrompt`:

- `first` controls the current title instruction and becomes `false` for resumed threads;
- `appendSystemPromptInjected` tracks a user-configured prompt and is set to `true` when an existing thread resumes;
- neither state can safely guarantee that an older resumed thread has received the new browser reporting contract.

Add a dedicated boolean named `browserStepPromptInjected` with these rules:

1. Initialize `false` for a new Happy CLI process, including when resuming an existing Codex thread.
2. Pass `includeBrowserStepInstruction: !browserStepPromptInjected` to `buildCodexTurnPrompt()`.
3. After `sendTurnAndWait()` successfully starts/completes the first attempted prompt turn, set the boolean to `true`.
4. Reset it to `false` in `resetCodexThreadState()` so a fresh/replaced thread receives the contract.
5. Do not tie it to `first` or `appendSystemPromptInjected`.

This means a resumed pre-feature Codex thread receives the contract on its first new Happy turn without receiving an unnecessary title instruction.

The instruction will use the existing `CODEX_HAPPY_SYSTEM_PROMPT_START` and `CODEX_HAPPY_SYSTEM_PROMPT_END` markers so it does not leak into the visible/forked conversation transcript.

### 4.3 Provider scope

Version 1 supports Codex and Claude only because both already have:

- a verified Happy-owned prompt injection path;
- `report_browser_step` MCP registration;
- a working encrypted attachment/session event path.

Gemini, ACP, OpenCode, and other agent flavors are explicitly out of scope until they have both capabilities. The shared constant is provider-neutral so later integrations can reuse the same wording.

## 5. Runtime Data Flow

```text
Happy starts Codex or Claude session
└── inject BROWSER_STEP_REPORTING_INSTRUCTION once per agent context

User requests browser automation
└── Agent selects existing ego-browser / ego-ops skill
    └── Agent executes one meaningful Ego round
        ├── operate browser
        ├── verify observable result
        └── capture PNG/JPEG at verified final state

Agent calls mcp__happy__report_browser_step
└── { path: absolutePath, label: completedStateLabel }
    └── reportBrowserStep handler
        ├── ApiSessionClient.uploadImageAttachment(path)
        │   ├── read local file
        │   ├── enforce existing 50 MB image limit
        │   ├── encrypt with session blob key
        │   └── upload through existing attachment endpoint
        └── ApiSessionClient.sendFileEvent(...)
            └── {
                  t: "file",
                  source: "browser_step",
                  browserStep: { label },
                  ref,
                  image: { width, height, thumbhash: "" }
                }

Happy App receives session event
├── getBrowserSteps(messages) projects source === "browser_step"
└── BrowserStepsPanel re-renders and selects the latest frame
```

There are no new server endpoints, database tables, object formats, message types, or panel state changes.

## 6. Error Handling

### 6.1 Screenshot capture failure

If Ego cannot produce a valid local PNG/JPEG path, the agent must not call `report_browser_step` with a guessed or nonexistent path. It may continue the underlying browser task when safe, but must disclose that the visual step was not reported.

### 6.2 MCP tool unavailable

If `mcp__happy__report_browser_step` is unavailable, the agent must not improvise a shell upload, use `send_image`, or claim that the panel updated. The browser task may continue when safe, and the final response must state that step visualization was unavailable.

### 6.3 Upload/tool failure

The existing handler returns an explicit MCP error result. Version 1 does not add a retry queue or idempotency key, so the agent does not retry automatically. It discloses the missing visual step and must not claim that the panel updated. This preserves the one-attempt-per-round contract and avoids duplicate reports after ambiguous failures.

### 6.4 Browser operation failure

Failed or unverified browser operations do not create success steps. The agent may capture diagnostics for its own reasoning, but it must not send those diagnostics to the completed-step panel under a success label.

## 7. Security and Privacy

- Screenshots continue to use the existing client-side session blob encryption before upload.
- The system prompt contains no credentials, session identifiers, OSS configuration, local user paths, or site data.
- The prompt requires absolute local paths only as MCP input; the remote event stores the encrypted attachment reference rather than the local path.
- Existing session ownership checks, file size limits, attachment prefix validation, and presigned URL behavior remain unchanged.
- The feature does not broaden the user's browser authorization. Ego and `ego-ops` authorization rules continue to govern what the agent may do.

## 8. Compatibility and Rollout

### 8.1 Compatibility

- Existing sessions without Ego usage behave unchanged because the prompt is conditional.
- Existing browser-step events and panels remain compatible because the wire schema does not change.
- Existing clients that do not display the browser-steps panel still receive a valid file event and do not require a server migration.
- User-supplied Claude/Codex append prompts are preserved.

### 8.2 Delivery

This is a Happy CLI-only change. Local development picks it up after rebuilding `packages/happy-cli/dist`; already-running agent processes keep their loaded code/prompt and require a new session or process. Other users require a published CLI package containing the change.

No Web deployment, App OTA, server deployment, daemon restart, simulator, or device validation is required for the code change itself.

## 9. Observability

Existing debug logs already provide the relevant success/failure evidence:

- `[happyMCP] Reporting browser step: ...`
- `[happyMCP] Response: { success: true | false }`
- emitted session file event with `source: "browser_step"`

Version 1 does not add analytics, screenshot contents to logs, or a new telemetry event. Tests should assert prompt/tool contracts rather than relying on production logs.

## 10. Implementation Surface

Expected files:

- Add `packages/happy-cli/src/browser/browserStepReportingPrompt.ts`
- Add `packages/happy-cli/src/browser/browserStepReportingPrompt.test.ts`
- Modify `packages/happy-cli/src/claude/utils/systemPrompt.ts`
- Modify `packages/happy-cli/src/claude/utils/systemPrompt.test.ts`
- Modify `packages/happy-cli/src/codex/codexPrompt.ts`
- Modify `packages/happy-cli/src/codex/codexPrompt.test.ts`
- Modify `packages/happy-cli/src/codex/runCodex.ts`
- Modify `packages/happy-cli/src/claude/utils/startHappyServer.ts`
- Modify `packages/happy-cli/src/codex/happyMcpBridgeTools.ts`
- Update colocated MCP bridge/registration tests if their expected descriptions change

No `happy-app`, `happy-server`, `happy-wire`, Ego installation, or Ego Skill files are changed.

## 11. Verification Plan

### 11.1 Unit tests

1. Shared prompt contract test:
   - references `ego-browser`, `ego-ops`, and `mcp__happy__report_browser_step`;
   - requires a completed and verified round;
   - requires the final frame;
   - excludes waits/retries/failed states as separate steps;
   - contains no credentials or provider-specific prompt syntax.

2. Claude prompt tests:
   - shared instruction is present exactly once in `systemPrompt`;
   - existing title/archive instructions remain present;
   - existing commit-attribution regression remains green.

3. Codex prompt tests:
   - browser instruction is injected on the first new turn;
   - it is not injected on ordinary follow-up turns;
   - it can be injected on a resumed thread without the title instruction;
   - it can be reinjected after thread reset;
   - user append prompts and runtime-setting messages preserve their current ordering.

4. Tool registration tests:
   - HTTP MCP and stdio bridge use the shared browser-step description;
   - the tool name, path/label schema, forwarding target, and dedicated-panel behavior remain unchanged.

### 11.2 Static verification

- Run the targeted Vitest files for the shared prompt, Claude prompt, Codex prompt, and MCP bridge.
- Run the Happy CLI typecheck/build command defined by the package.
- Run existing browser-step-related CLI tests that cover bridge forwarding and permissions.

### 11.3 Optional live behavioral acceptance

With explicit approval to start live agent sessions and Ego browser automation, use a fresh Codex session and a fresh Claude session for one read-only Ego task with at least two meaningful rounds. Acceptance requires:

- the agent uses the existing Ego Skill, not a new Happy Skill;
- each successful meaningful round produces one `report_browser_step` tool call;
- labels describe completed states;
- the final frame is reported before task-space completion;
- the existing right panel displays frames in order;
- a non-Ego control task does not attempt to call the browser-step tool.

Because model adherence is nondeterministic, this acceptance validates the shipped prompt behavior but is not treated as a proof of mechanical exactly-once delivery. It is a release confidence check rather than a prerequisite for completing the static code change.

## 12. Explicit Non-Goals

- Guaranteed interception of every Ego action
- Native Ego hooks or modifications
- A Happy-owned browser skill or Ego skill fork
- Process/window monitoring or periodic screenshots
- Automatic screenshot deduplication
- Background upload queue or durable retry
- Screenshot TTL/storage changes
- Semantic step extraction by Happy
- Support for agent providers beyond Codex and Claude
- UI changes to the existing Browser Steps panel

## 13. Success Criteria

The version is complete when:

1. Fresh and resumed Happy Codex sessions receive the conditional instruction exactly once per agent context.
2. Fresh and resumed Happy Claude sessions receive the instruction through the existing append system prompt path.
3. Both MCP registration paths expose the same reinforced tool description.
4. The existing screenshot upload and panel event schemas remain unchanged.
5. Targeted tests and Happy CLI build pass.
6. If live validation is separately approved, fresh-session read-only Ego acceptance demonstrates ordered browser-step reports for Codex and Claude while a non-Ego control task produces none.
