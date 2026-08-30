# Ego Browser Step Reporting Prompt Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Happy's Codex and Claude sessions instruct Ego browser automation to report every meaningful completed round through the existing browser-step screenshot tool.

**Architecture:** Add one provider-neutral prompt/description module, inject its instruction through Claude's existing append system prompt and Codex's marked turn preamble, and reuse the shared tool description in both MCP registration paths. Keep the existing screenshot upload, event schema, server storage, and App panel unchanged.

**Tech Stack:** TypeScript, Vitest, Codex app-server prompt assembly, Claude append system prompt, MCP SDK, pnpm workspace.

**Spec:** `docs/superpowers/specs/2026-08-30-ego-browser-step-reporting-prompt-design.md`

## Global Constraints

- Version 1 supports Codex and Claude only.
- The prompt is conditional on using `ego-browser`, `ego-ops`, or Ego Lite.
- One report is required after each meaningful completed and verified Ego round and before the next round.
- Waits, retries, tiny scrolls, failed actions, and unverified states are not separate steps.
- The final verified browser state must be reported before task completion.
- The existing `report_browser_step({ path, label })` input and browser-step event schema remain unchanged.
- Screenshot TTL/storage changes are not part of this implementation because retention duration is not yet approved.

---

### Task 1: Shared browser-step reporting contract and Claude injection

**Files:**
- Create: `packages/happy-cli/src/browser/browserStepReportingPrompt.ts`
- Create: `packages/happy-cli/src/browser/browserStepReportingPrompt.test.ts`
- Modify: `packages/happy-cli/src/claude/utils/systemPrompt.ts`
- Modify: `packages/happy-cli/src/claude/utils/systemPrompt.test.ts`

**Interfaces:**
- Produces: `BROWSER_STEP_REPORTING_INSTRUCTION: string`
- Produces: `BROWSER_STEP_TOOL_DESCRIPTION: string`
- Consumes: Claude's existing exported `systemPrompt`

- [ ] **Step 1: Write failing contract and Claude prompt tests**

```ts
expect(BROWSER_STEP_REPORTING_INSTRUCTION).toContain('ego-browser');
expect(BROWSER_STEP_REPORTING_INSTRUCTION).toContain('ego-ops');
expect(BROWSER_STEP_REPORTING_INSTRUCTION).toContain('mcp__happy__report_browser_step');
expect(BROWSER_STEP_REPORTING_INSTRUCTION).toMatch(/completed and verified/i);
expect(BROWSER_STEP_REPORTING_INSTRUCTION).toMatch(/final verified browser state/i);
expect(systemPrompt.split(BROWSER_STEP_REPORTING_INSTRUCTION)).toHaveLength(2);
```

- [ ] **Step 2: Run tests and verify RED**

Run: `pnpm --filter @wangjs-jacky/paws exec vitest run src/browser/browserStepReportingPrompt.test.ts src/claude/utils/systemPrompt.test.ts`

Expected: FAIL because the browser prompt module and Claude injection do not exist.

- [ ] **Step 3: Add the shared constants and append the instruction to Claude's prompt**

```ts
export const BROWSER_STEP_REPORTING_INSTRUCTION =
    'Whenever you use `ego-browser`, `ego-ops`, or Ego Lite for browser automation, report every meaningful completed and verified browser round to Happy. At the end of the round, before starting the next Ego browser round, capture the current browser view as a PNG or JPEG and call `mcp__happy__report_browser_step` exactly once with the absolute screenshot path and a short completed-state label. Do not report waits, retries, tiny scrolls, low-level helper calls, failed actions, or unverified states as separate steps. Before completing or closing the Ego task space, always report the final verified browser state. If screenshot capture or reporting fails, continue the browser task only when safe, disclose the missing visual step, and never claim that the panel was updated.';
export const BROWSER_STEP_TOOL_DESCRIPTION =
    'Report one completed and verified Ego browser round with its current PNG/JPEG screenshot. Call after each meaningful Ego browser round and before the next round; the frame appears in the dedicated browser-steps panel, not normal chat.';

export const systemPrompt = (() => trimIdent(`
    ALWAYS when you start a new chat - you must call a tool "mcp__happy__change_title" to set a chat title. When you think chat title is not relevant anymore - call the tool again to change it. When chat name is too generic and you have a change to make it more specific - call the tool again to change it. This title is needed to easily find the chat in the future. Help human.
    If the user explicitly asks you to archive, close, or end the current Happy chat session after finishing the task, complete the task first and then call "mcp__happy__archive_session".
    ${BROWSER_STEP_REPORTING_INSTRUCTION}
`))();
```

- [ ] **Step 4: Run tests and verify GREEN**

Run: `pnpm --filter @wangjs-jacky/paws exec vitest run src/browser/browserStepReportingPrompt.test.ts src/claude/utils/systemPrompt.test.ts`

Expected: PASS.

### Task 2: Codex one-time prompt injection state

**Files:**
- Modify: `packages/happy-cli/src/codex/codexPrompt.ts`
- Modify: `packages/happy-cli/src/codex/codexPrompt.test.ts`
- Modify: `packages/happy-cli/src/codex/runCodex.ts`
- Modify: `packages/happy-cli/src/codex/__tests__/sessionProtocolMapper.test.ts`

**Interfaces:**
- Consumes: `BROWSER_STEP_REPORTING_INSTRUCTION`
- Extends: `buildCodexTurnPrompt({ includeBrowserStepInstruction: boolean })`
- Adds runtime state: `browserStepPromptInjected: boolean`

- [ ] **Step 1: Write failing Codex prompt tests**

```ts
expect(buildCodexTurnPrompt({
    message: 'continue',
    mode: {},
    includeAppendSystemPrompt: false,
    includeBrowserStepInstruction: true,
    includeTitleInstruction: false,
})).toContain(BROWSER_STEP_REPORTING_INSTRUCTION);

expect(buildCodexTurnPrompt({
    message: 'continue',
    mode: {},
    includeAppendSystemPrompt: false,
    includeBrowserStepInstruction: false,
    includeTitleInstruction: false,
})).toBe('continue');
```

Update existing prompt fixtures to pass the new required boolean and assert the marked instruction is stripped by the session protocol mapper.

- [ ] **Step 2: Run tests and verify RED**

Run: `pnpm --filter @wangjs-jacky/paws exec vitest run src/codex/codexPrompt.test.ts src/codex/__tests__/sessionProtocolMapper.test.ts`

Expected: FAIL because `includeBrowserStepInstruction` is not accepted or rendered.

- [ ] **Step 3: Implement prompt assembly and lifecycle state**

```ts
if (opts.includeBrowserStepInstruction) {
    parts.push(
        CODEX_HAPPY_SYSTEM_PROMPT_START,
        BROWSER_STEP_REPORTING_INSTRUCTION,
        CODEX_HAPPY_SYSTEM_PROMPT_END,
    );
}
```

In `runCodex.ts`, initialize `browserStepPromptInjected = false`, pass its inverse into `buildCodexTurnPrompt`, set it after a successful `sendTurnAndWait`, and reset it in `resetCodexThreadState`. Do not change it when resuming an existing thread so pre-feature threads receive the new instruction on their first Happy turn.

- [ ] **Step 4: Run tests and verify GREEN**

Run: `pnpm --filter @wangjs-jacky/paws exec vitest run src/codex/codexPrompt.test.ts src/codex/__tests__/sessionProtocolMapper.test.ts`

Expected: PASS.

### Task 3: Align MCP tool descriptions and verify the CLI package

**Files:**
- Modify: `packages/happy-cli/src/claude/utils/startHappyServer.ts`
- Modify: `packages/happy-cli/src/codex/happyMcpBridgeTools.ts`
- Modify: `packages/happy-cli/src/codex/happyMcpBridgeTools.test.ts`

**Interfaces:**
- Consumes: `BROWSER_STEP_TOOL_DESCRIPTION`
- Preserves: `report_browser_step({ path: string, label: string })`

- [ ] **Step 1: Write a failing bridge registration assertion**

```ts
expect(reportBrowserStep?.config.description).toBe(BROWSER_STEP_TOOL_DESCRIPTION);
```

- [ ] **Step 2: Run the bridge test and verify RED**

Run: `pnpm --filter @wangjs-jacky/paws exec vitest run src/codex/happyMcpBridgeTools.test.ts`

Expected: FAIL because the stdio bridge still uses its prior description.

- [ ] **Step 3: Reuse the shared description in both MCP registrations**

```ts
description: BROWSER_STEP_TOOL_DESCRIPTION,
```

Keep the tool names, titles, path/label Zod schemas, handlers, forwarding target, and file-event behavior unchanged.

- [ ] **Step 4: Run targeted tests**

Run: `pnpm --filter @wangjs-jacky/paws exec vitest run src/browser/browserStepReportingPrompt.test.ts src/claude/utils/systemPrompt.test.ts src/codex/codexPrompt.test.ts src/codex/__tests__/sessionProtocolMapper.test.ts src/codex/happyMcpBridgeTools.test.ts src/codex/__tests__/permissionHandler.test.ts`

Expected: PASS.

- [ ] **Step 5: Build the Happy CLI**

Run: `pnpm --filter @wangjs-jacky/paws run build`

Expected: TypeScript typecheck and pkgroll build both succeed.

- [ ] **Step 6: Commit implementation**

```bash
git add packages/happy-cli/src/browser packages/happy-cli/src/claude/utils/systemPrompt.ts packages/happy-cli/src/claude/utils/systemPrompt.test.ts packages/happy-cli/src/claude/utils/startHappyServer.ts packages/happy-cli/src/codex/codexPrompt.ts packages/happy-cli/src/codex/codexPrompt.test.ts packages/happy-cli/src/codex/runCodex.ts packages/happy-cli/src/codex/__tests__/sessionProtocolMapper.test.ts packages/happy-cli/src/codex/happyMcpBridgeTools.ts packages/happy-cli/src/codex/happyMcpBridgeTools.test.ts
git commit -m "feat(browser): prompt agents to report Ego steps"
```
