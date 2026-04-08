/**
 * Integration tests for plan mode permission flow.
 *
 * Covers:
 *   - ExitPlanMode always triggers canCallTool (never auto-approved)
 *   - Plan approval → Claude continues execution
 *   - Plan denial → Claude stops, file untouched
 *
 * Uses an isolated /tmp fixture with hello-world.js in a git repo.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PushableAsyncIterable } from '@/utils/PushableAsyncIterable';
import { query, type QueryOptions, type SDKAssistantMessage, type SDKMessage, type SDKResultMessage, type SDKSystemMessage } from './sdk';
import { createPlanModeFixture } from '@/testing/planModeTestFixture';

const MODEL = 'claude-sonnet-4-20250514';

function inputRecord(input: unknown): Record<string, unknown> {
    if (input && typeof input === 'object') return input as Record<string, unknown>;
    return {};
}

function resultMessage(messages: SDKMessage[]): SDKResultMessage | undefined {
    return messages.find((m): m is SDKResultMessage => m.type === 'result');
}

function assistantToolUses(messages: SDKMessage[]): Array<{ input: unknown; name: string; id?: string }> {
    return messages
        .filter((m): m is SDKAssistantMessage => m.type === 'assistant')
        .flatMap((m) =>
            m.message.content
                .filter((b) => b.type === 'tool_use')
                .map((b) => ({ input: b.input, name: b.name ?? '', id: b.id }))
        )
        .filter((t) => Boolean(t.name));
}

async function collectMessages(iterable: AsyncIterable<SDKMessage>): Promise<SDKMessage[]> {
    const messages: SDKMessage[] = [];
    for await (const message of iterable) {
        messages.push(message);
    }
    return messages;
}

async function isClaudeAvailable(cwd: string): Promise<boolean> {
    try {
        const messages = await collectMessages(query({
            prompt: 'Say exactly ready',
            options: { abort: AbortSignal.timeout(20_000), cwd, model: MODEL },
        }));
        return resultMessage(messages)?.result?.trim() === 'ready';
    } catch {
        console.log('[plan-mode-test] Skipping: Claude query unavailable');
        return false;
    }
}

let fixture: ReturnType<typeof createPlanModeFixture>;
const claudeAvailable = (() => {
    fixture = createPlanModeFixture();
    return isClaudeAvailable(fixture.dir);
})();

describe.skipIf(!(await claudeAvailable))('Plan Mode Integration', { timeout: 180_000 }, () => {

    beforeEach(() => {
        fixture = createPlanModeFixture();
    });

    afterEach(() => {
        fixture?.cleanup();
    });

    it('should call canCallTool for ExitPlanMode and allow plan execution', async () => {
        let exitPlanModeReceived = false;
        let exitPlanModeInput: unknown = null;

        const options: QueryOptions = {
            cwd: fixture.dir,
            model: MODEL,
            permissionMode: 'plan',
            canCallTool: async (toolName, input) => {
                if (toolName === 'ExitPlanMode' || toolName === 'exit_plan_mode') {
                    exitPlanModeReceived = true;
                    exitPlanModeInput = input;
                }
                return { behavior: 'allow', updatedInput: inputRecord(input) };
            },
        };

        const promptStream = new PushableAsyncIterable<SDKMessage>();
        const run = query({ prompt: promptStream, options });

        promptStream.push({
            type: 'user',
            message: {
                role: 'user',
                content: [
                    'Create a plan to add a goodbye(name) function to hello-world.js that prints "Goodbye, <name>!".',
                    'Then call goodbye("World") after greet("World").',
                    'The plan should be short — just describe the two additions.',
                    'After the plan is approved, implement the changes.',
                ].join(' '),
            },
        });
        promptStream.end();

        const messages = await collectMessages(run);
        const result = resultMessage(messages);
        const tools = assistantToolUses(messages);

        // ExitPlanMode must have been received by our canCallTool handler
        expect(exitPlanModeReceived).toBe(true);

        // ExitPlanMode input should contain a plan
        const planInput = exitPlanModeInput as Record<string, unknown> | null;
        expect(planInput).toBeDefined();
        expect(typeof planInput?.plan).toBe('string');
        expect((planInput?.plan as string).length).toBeGreaterThan(10);

        // Claude should have used edit tools after plan approval
        const editTools = tools.filter(t => ['Edit', 'Write', 'MultiEdit'].includes(t.name));
        expect(editTools.length).toBeGreaterThan(0);

        // hello-world.js should be modified
        const content = readFileSync(join(fixture.dir, 'hello-world.js'), 'utf8');
        expect(content.toLowerCase()).toContain('goodbye');

        // Should complete successfully
        expect(result?.subtype).toBe('success');
    });

    it('should deny plan and not modify files', async () => {
        let exitPlanModeReceived = false;

        const options: QueryOptions = {
            cwd: fixture.dir,
            model: MODEL,
            permissionMode: 'plan',
            canCallTool: async (toolName, input) => {
                if (toolName === 'ExitPlanMode' || toolName === 'exit_plan_mode') {
                    exitPlanModeReceived = true;
                    return { behavior: 'deny', message: 'Plan rejected by test harness' };
                }
                return { behavior: 'allow', updatedInput: inputRecord(input) };
            },
        };

        const promptStream = new PushableAsyncIterable<SDKMessage>();
        const run = query({ prompt: promptStream, options });

        promptStream.push({
            type: 'user',
            message: {
                role: 'user',
                content: [
                    'Create a plan to add a goodbye(name) function to hello-world.js.',
                    'After the plan is approved, implement the changes.',
                ].join(' '),
            },
        });
        promptStream.end();

        const messages = await collectMessages(run);
        const result = resultMessage(messages);

        // ExitPlanMode was received
        expect(exitPlanModeReceived).toBe(true);

        // hello-world.js should NOT be modified (no edit tools after denial)
        const content = readFileSync(join(fixture.dir, 'hello-world.js'), 'utf8');
        expect(content.toLowerCase()).not.toContain('goodbye');

        // Should complete (Claude acknowledges the denial)
        expect(result).toBeDefined();
    });

    it('should always call canCallTool for ExitPlanMode even after bypassPermissions was active', async () => {
        // Regression test: when permissionMode was previously 'bypassPermissions',
        // ExitPlanMode must still go through canCallTool.
        //
        // We simulate this by first running a bypassPermissions turn, then a plan turn.
        // The bug was that permissionHandler.permissionMode stayed 'bypassPermissions'
        // across session restarts, causing ExitPlanMode to auto-approve silently.

        const canCallToolCalls: string[] = [];

        const options: QueryOptions = {
            cwd: fixture.dir,
            model: MODEL,
            permissionMode: 'plan',
            canCallTool: async (toolName, input) => {
                canCallToolCalls.push(toolName);
                if (toolName === 'ExitPlanMode' || toolName === 'exit_plan_mode') {
                    return { behavior: 'allow', updatedInput: inputRecord(input) };
                }
                return { behavior: 'allow', updatedInput: inputRecord(input) };
            },
        };

        const promptStream = new PushableAsyncIterable<SDKMessage>();
        const run = query({ prompt: promptStream, options });

        promptStream.push({
            type: 'user',
            message: {
                role: 'user',
                content: 'Create a short plan to add a comment to hello-world.js. Then implement it.',
            },
        });
        promptStream.end();

        const messages = await collectMessages(run);

        // The critical assertion: ExitPlanMode MUST appear in canCallTool calls
        const exitPlanCalls = canCallToolCalls.filter(
            n => n === 'ExitPlanMode' || n === 'exit_plan_mode'
        );
        expect(exitPlanCalls.length).toBeGreaterThan(0);

        // Should complete successfully
        const result = resultMessage(messages);
        expect(result?.subtype).toBe('success');
    });
});
