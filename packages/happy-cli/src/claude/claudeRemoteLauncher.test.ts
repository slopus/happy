import { beforeEach, describe, expect, it, vi } from 'vitest';
import { claudeRemote } from './claudeRemote';
import { claudeRemoteLauncher } from './claudeRemoteLauncher';
import { closeClaudeTurnWithStatus, mapClaudeLogMessageToSessionEnvelopes, type ClaudeSessionProtocolState } from './utils/sessionProtocolMapper';
import { CLAUDE_LOGIN_EXPIRED_MESSAGE } from './utils/providerAuth';
import type { SessionEnvelope } from '@slopus/happy-wire';

// Exercise the real outgoing queue, SDK converter and protocol mapper without
// a terminal, credential store, provider process, relay or push service.
vi.mock('./claudeRemote', () => ({ claudeRemote: vi.fn() }));
vi.mock('ink', () => ({ render: vi.fn() }));
vi.mock('@/ui/ink/RemoteModeDisplay', () => ({ RemoteModeDisplay: vi.fn() }));
vi.mock('@/ui/logger', () => ({ logger: { debug: vi.fn() } }));
vi.mock('@/ui/messageFormatterInk', () => ({ formatClaudeMessageForInk: vi.fn() }));
vi.mock('@/utils/terminalStdinCleanup', () => ({ cleanupStdinAfterInk: vi.fn() }));
vi.mock('node:child_process', () => ({ execSync: () => 'fixture-branch' }));
vi.mock('./utils/permissionHandler', () => ({
    PermissionHandler: class {
        reset = vi.fn();
        setOnPermissionRequest = vi.fn();
        getResponseLookup = () => new Map();
        handleToolCall = vi.fn();
        handleModeChange = vi.fn();
    },
}));

function fixture() {
    const handlers = new Map<string, () => Promise<void>>();
    const state: ClaudeSessionProtocolState = { currentTurnId: null };
    const envelopes: SessionEnvelope[] = [];
    const session = {
        sessionId: 'fixture-session', path: '/fixture/project', hookSettingsPath: '/fixture/settings.json',
        queue: { size: () => 0 },
        consumeOneTimeFlags: vi.fn(),
        api: { push: () => ({ sendSessionNotification: notification }) },
        client: {
            sessionId: 'fixture-happy-session',
            rpcHandlerManager: { registerHandler: (name: string, handler: () => Promise<void>) => handlers.set(name, handler) },
            getMetadata: () => ({}),
            sendSessionEvent: vi.fn(),
            sendClaudeSessionMessage: vi.fn((message) => {
                const mapped = mapClaudeLogMessageToSessionEnvelopes(message, state);
                state.currentTurnId = mapped.currentTurnId;
                envelopes.push(...mapped.envelopes);
            }),
            closeClaudeSessionTurn: vi.fn((status) => {
                const mapped = closeClaudeTurnWithStatus(state, status);
                state.currentTurnId = mapped.currentTurnId;
                envelopes.push(...mapped.envelopes);
            }),
        },
    };
    const notification = vi.fn();
    const stop = () => { void handlers.get('switch')!(); };
    return { session, state, envelopes, notification, stop };
}

describe('claudeRemoteLauncher provider auth', () => {
    beforeEach(() => { vi.mocked(claudeRemote).mockReset(); });

    it('flushes back-to-back auth output before closing the failed wire turn, without a done push', async () => {
        const { session, state, envelopes, notification, stop } = fixture();
        let eventsAtReady: string[] = [];
        let turnAtReady: string | null | undefined;
        vi.mocked(claudeRemote).mockImplementation(async opts => {
            opts.onCompletionEvent?.(CLAUDE_LOGIN_EXPIRED_MESSAGE);
            opts.onMessage({
                type: 'assistant', error: 'authentication_failed', parent_tool_use_id: null,
                message: { role: 'assistant', content: [{ type: 'text', text: 'Provider login failed' }] },
            } as any);
            await opts.onReady('failed');
            // Verify before cleanup's final flush can hide incorrect ordering.
            eventsAtReady = envelopes.map(envelope => envelope.ev.t);
            turnAtReady = state.currentTurnId;
            stop();
        });
        await claudeRemoteLauncher(session as any);
        expect(eventsAtReady).toEqual(['turn-start', 'text', 'turn-end']);
        expect(envelopes.at(-1)?.ev).toEqual({ t: 'turn-end', status: 'failed' });
        expect(turnAtReady).toBeNull();
        expect(notification).not.toHaveBeenCalled();
        expect(session.client.sendSessionEvent).toHaveBeenCalledWith({ type: 'message', message: CLAUDE_LOGIN_EXPIRED_MESSAGE });
        expect(envelopes.filter(envelope => envelope.ev.t === 'turn-end')).toHaveLength(1);
    });

    it('runs remote Claude with the session sandbox', async () => {
        const { session, stop } = fixture();
        const sandboxConfig = { enabled: true };
        (session as any).sandboxConfig = sandboxConfig;
        vi.mocked(claudeRemote).mockImplementationOnce(async () => { stop(); });
        await claudeRemoteLauncher(session as any);
        expect(claudeRemote).toHaveBeenCalledWith(expect.objectContaining({ sandboxConfig }));
    });

    it('shows untruncated host-login guidance for a thrown OAuth error and accepts a later invocation', async () => {
        const { session, notification, stop } = fixture();
        vi.mocked(claudeRemote)
            .mockRejectedValueOnce(new Error('Failed to authenticate: OAuth session expired and could not be refreshed\nhttps://fixture-secret@example.invalid'))
            .mockImplementationOnce(async () => { stop(); });
        await claudeRemoteLauncher(session as any);
        expect(session.client.closeClaudeSessionTurn).toHaveBeenCalledWith('failed');
        expect(session.client.sendSessionEvent).toHaveBeenCalledWith({ type: 'message', message: CLAUDE_LOGIN_EXPIRED_MESSAGE });
        expect(JSON.stringify(session.client.sendSessionEvent.mock.calls)).not.toContain('fixture-secret');
        expect(notification).not.toHaveBeenCalled();
        expect(claudeRemote).toHaveBeenCalledTimes(2);
    });
});
describe('claudeRemoteLauncher model switches', () => {
    beforeEach(() => { vi.mocked(claudeRemote).mockReset(); });

    it.each([false, true])('preserves images across consecutive switches (isolated: %s)', async isolate => {
        const { session, stop } = fixture();
        const sent = ['opus', 'fable', 'sonnet'].map((model, index) => ({
            message: `on ${model}`, mode: { permissionMode: 'default', model }, hash: model,
            isolate: index === 2 && isolate,
            attachments: index === 2 ? [{ name: 'image.png', mimeType: 'image/png', data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) }] : [],
        }));
        (session.queue as any).waitForMessagesAndGetAsString = vi.fn(async () => sent.shift() ?? null);
        const queries: Array<Array<{ message: unknown; model: string | undefined }>> = [];
        vi.mocked(claudeRemote).mockImplementation(async opts => {
            const received: typeof queries[number] = [];
            for (let next = await opts.nextMessage(); next; next = await opts.nextMessage()) {
                received.push({ message: next.message, model: next.mode.model });
            }
            queries.push(received);
            if (queries.length === 3) stop();
        });
        await claudeRemoteLauncher(session as any);
        expect(queries).toEqual([
            [{ message: 'on opus', model: 'opus' }],
            [{ message: 'on fable', model: 'fable' }],
            [{ message: [
                { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } },
                { type: 'text', text: 'on sonnet' },
            ], model: 'sonnet' }],
        ]);
    });

    it('starts a new query for every model switch, including one right after another', async () => {
        const { session, stop } = fixture();
        const sent = ['opus', 'fable', 'sonnet'].map(model => ({
            message: `on ${model}`, mode: { permissionMode: 'default', model }, hash: model, isolate: false,
        }));
        (session.queue as any).waitForMessagesAndGetAsString = vi.fn(async () => sent.shift() ?? null);
        const queries: string[][] = [];
        vi.mocked(claudeRemote).mockImplementation(async opts => {
            const received: string[] = [];
            for (let next = await opts.nextMessage(); next; next = await opts.nextMessage()) {
                received.push(next.mode.model!);
            }
            queries.push(received);
            if (queries.length === 3) stop();
        });
        await claudeRemoteLauncher(session as any);
        expect(queries).toEqual([['opus'], ['fable'], ['sonnet']]);
    });
});
