import { describe, expect, it, vi } from 'vitest';
import { query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { claudeRemoteLauncher } from './claudeRemoteLauncher';
import type { Session } from './session';
import type { EnhancedMode } from './loop';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import { hashObject } from '@/utils/deterministicJson';
import { RuntimeProducerGate } from '@/sessionDrain/runtimeProducerGate';
import { ClaudeStandaloneDrain } from './claudeStandaloneDrain';

vi.mock('@anthropic-ai/claude-agent-sdk', async (original) => ({
    ...await original<typeof import('@anthropic-ai/claude-agent-sdk')>(),
    query: vi.fn(),
}));

function harness() {
    const queue = new MessageQueue2<EnhancedMode>(hashObject);
    let drain!: ClaudeStandaloneDrain;
    const gate = new RuntimeProducerGate({
        hasUndeliveredInput: () => queue.size() > 0,
        canFreezeInbound: () => true,
        freezeInbound: () => true,
        stopLoop: () => { drain.providerDeps().requestEndInput(); },
    });
    drain = new ClaudeStandaloneDrain(gate);
    const client = {
        sessionId: 'standalone-drain-test',
        rpcHandlerManager: { registerHandler: vi.fn() },
        updateAgentState: vi.fn(), updateMetadata: vi.fn(), getMetadata: () => ({}),
        sendClaudeSessionMessage: vi.fn(), sendStreamDelta: vi.fn(),
        setPendingTurnRequestId: vi.fn(), sendFinalAnswerForChannelTurn: vi.fn(),
        applyClaudeTurnResult: vi.fn(), closeClaudeSessionTurn: vi.fn(), sendSessionEvent: vi.fn(),
    };
    const session = {
        lessonReviewLifecycle: { controller: new AbortController(), completedAssistantTurns: 0 },
        cancelLessonReview: vi.fn(),
        sessionId: null, path: process.cwd(), queue, client, mcpServers: {},
        api: { push: () => ({ sendSessionNotification: vi.fn() }) },
        consumeOneTimeFlags: vi.fn(), onThinkingChange: vi.fn(),
        standaloneDrain: drain,
    } as unknown as Session;
    return { queue, gate, drain, session };
}

describe('Claude launcher under a Windows standalone drain', () => {
    it('marks the turn dispatched while it runs, offers interrupt, and ends input when the gate freezes after the turn', async () => {
        const { queue, gate, drain, session } = harness();
        const seen: Array<{ blocker: string | null; interruptible: boolean }> = [];
        const interrupt = vi.fn(async () => undefined);
        vi.mocked(query).mockImplementation(({ prompt }) => {
            const response = (async function* () {
                yield { type: 'system', subtype: 'init', session_id: '', tools: [], mcp_servers: [] };
                for await (const _message of prompt as AsyncIterable<SDKUserMessage>) {
                    seen.push({ blocker: gate.blocker(), interruptible: drain.providerDeps().activeTurn() !== null });
                    yield { type: 'result', subtype: 'success', result: '', is_error: false, uuid: 'result-1' };
                    // The turn has ended; the daemon's drain freezes the runtime now.
                    expect(drain.providerDeps().activeTurn()).toBeNull();
                    gate.freeze();
                }
            })();
            return Object.assign(response, { mcpServerStatus: async () => [], setPermissionMode: async () => {}, interrupt }) as unknown as ReturnType<typeof query>;
        });
        queue.push('turn-0', { permissionMode: 'default', model: 'claude-sonnet-5' });
        await expect(claudeRemoteLauncher(session)).resolves.toBe('exit');
        expect(seen).toEqual([{ blocker: null, interruptible: true }]);
        await drain.providerDeps().activeTurn()?.interrupt();
        expect(interrupt).not.toHaveBeenCalled();
        expect(drain.providerDeps().isLoopFinished()).toBe(true);
        expect(gate.isFrozen()).toBe(true);
        expect(gate.hasLiveProducers()).toBe(true); // runClaude records loopExited after its own last writes.
    });

    it('refuses a turn once input is closed, and ends the loop instead of running it', async () => {
        const { queue, gate, drain, session } = harness();
        vi.mocked(query).mockReset();
        gate.beginTermination();
        queue.push('late', { permissionMode: 'default', model: 'claude-sonnet-5' });
        const ended = claudeRemoteLauncher(session);
        // A kill closed input; the queued batch is never claimed, and the stop wakes the loop.
        drain.providerDeps().requestEndInput();
        queue.close();
        await expect(ended).resolves.toBe('exit');
        expect(query).not.toHaveBeenCalled();
        expect(drain.providerDeps().isLoopFinished()).toBe(true);
    });

    it('ends the loop on its own when a kill closed the gate with a batch still queued', async () => {
        const { queue, gate, drain, session } = harness();
        vi.mocked(query).mockReset();
        // runClaude's kill path only seals the gate; it neither requests a stop nor closes the queue.
        gate.beginTermination();
        queue.push('queued-behind-turn', { permissionMode: 'default', model: 'claude-sonnet-5' });
        let waits = 0;
        const wait = queue.waitForMessagesAndGetAsString.bind(queue);
        queue.waitForMessagesAndGetAsString = (signal, claim) => {
            waits += 1;
            // Safety valve so a relaunch spin fails this test instead of starving the worker.
            if (waits > 20) { drain.providerDeps().requestEndInput(); queue.close(); }
            return wait(signal, claim);
        };
        await expect(claudeRemoteLauncher(session)).resolves.toBe('exit');
        expect(waits).toBe(1);
        expect(query).not.toHaveBeenCalled();
        expect(queue.size()).toBe(1);
        expect(drain.providerDeps().isLoopFinished()).toBe(true);
    });
});
