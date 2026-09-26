import { describe, expect, it, vi } from 'vitest';
import { query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { claudeRemoteLauncher } from './claudeRemoteLauncher';
import type { Session } from './session';
import type { EnhancedMode } from './loop';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import { hashObject } from '@/utils/deterministicJson';
import type { ClaudeAuthObservation, ObservedAiAuthSource } from './aiAuthObservation';

vi.mock('@anthropic-ai/claude-agent-sdk', async (original) => ({
    ...await original<typeof import('@anthropic-ai/claude-agent-sdk')>(),
    query: vi.fn(),
}));

const observation = vi.hoisted(() => ({
    current: vi.fn<() => ObservedAiAuthSource | undefined>(),
    noteTurnApiKeySource: vi.fn(),
    dispose: vi.fn(),
}));

vi.mock('./aiAuthObservation', async (original) => ({
    ...await original<typeof import('./aiAuthObservation')>(),
    observeClaudeQueryAuth: vi.fn((): ClaudeAuthObservation => observation),
}));

function assistant(id: string) {
    return {
        type: 'assistant',
        uuid: `uuid-${id}`,
        session_id: '',
        parent_tool_use_id: null,
        message: {
            id, role: 'assistant', model: 'claude-sonnet-5',
            content: [{ type: 'text', text: 'hi' }],
            usage: { input_tokens: 1, output_tokens: 1 },
        },
    };
}

async function runOneTurn(onAssistant: () => void) {
    const queue = new MessageQueue2<EnhancedMode>(hashObject);
    const handlers = new Map<string, () => Promise<unknown>>();
    const client = {
        sessionId: 'observation-test',
        rpcHandlerManager: { registerHandler: (name: string, handler: () => Promise<unknown>) => handlers.set(name, handler) },
        updateAgentState: vi.fn(), updateMetadata: vi.fn(), getMetadata: () => ({}),
        sendClaudeSessionMessage: vi.fn(), sendStreamDelta: vi.fn(),
        setPendingTurnRequestId: vi.fn(), sendFinalAnswerForChannelTurn: vi.fn(),
        applyClaudeTurnResult: vi.fn(), closeClaudeSessionTurn: vi.fn(), sendSessionEvent: vi.fn(),
    };
    vi.mocked(query).mockImplementation(({ prompt }) => {
        const response = (async function* () {
            yield { type: 'system', subtype: 'init', session_id: '', tools: [], mcp_servers: [], apiKeySource: 'none' };
            for await (const _message of prompt as AsyncIterable<SDKUserMessage>) {
                onAssistant();
                yield assistant('msg-1');
                yield { type: 'result', subtype: 'success', result: 'hi', is_error: false, uuid: 'result-1' };
                void handlers.get('switch')!();
                return;
            }
        })();
        return Object.assign(response, {
            mcpServerStatus: async () => [],
            setPermissionMode: async () => {},
        }) as unknown as ReturnType<typeof query>;
    });
    queue.push('hello', { permissionMode: 'default', model: 'claude-sonnet-5' });
    const session = {
        lessonReviewLifecycle: { controller: new AbortController(), completedAssistantTurns: 0 },
        cancelLessonReview: vi.fn(),
        sessionId: null, path: process.cwd(), queue, client, mcpServers: {},
        api: { push: () => ({ sendSessionNotification: vi.fn() }) },
        consumeOneTimeFlags: vi.fn(), onThinkingChange: vi.fn(),
    } as unknown as Session;
    await claudeRemoteLauncher(session);
    return client;
}

function sentFor(client: Awaited<ReturnType<typeof runOneTurn>>, messageId: string) {
    return client.sendClaudeSessionMessage.mock.calls.find(
        ([body]) => (body as { message?: { id?: string } }).message?.id === messageId,
    );
}

describe('a remote run reports its observed org deployment login (src/claude/aiAuthObservation.ts)', () => {
    it('hands the observation to the usage of the messages it saw, then ends it with the run', async () => {
        observation.current.mockReset();
        observation.dispose.mockReset();
        observation.noteTurnApiKeySource.mockReset();
        observation.current.mockReturnValue(undefined);
        const client = await runOneTurn(() => observation.current.mockReturnValue('org-bundle-observed'));

        expect(observation.noteTurnApiKeySource).toHaveBeenCalledWith('none');
        expect(sentFor(client, 'msg-1')?.[2]).toBe('org-bundle-observed');
        expect(client.applyClaudeTurnResult).toHaveBeenCalledWith(
            expect.objectContaining({ uuid: 'result-1' }),
            'org-bundle-observed',
        );
        expect(observation.dispose).toHaveBeenCalledOnce();
    });

    it('reports nothing for a message that arrived before anything was observed', async () => {
        observation.current.mockReset();
        observation.current.mockReturnValue(undefined);
        const client = await runOneTurn(() => {});

        expect(sentFor(client, 'msg-1')).toBeDefined();
        expect(sentFor(client, 'msg-1')?.[2]).toBeUndefined();
        expect(client.applyClaudeTurnResult).toHaveBeenCalledWith(expect.objectContaining({ uuid: 'result-1' }), undefined);
    });
});
