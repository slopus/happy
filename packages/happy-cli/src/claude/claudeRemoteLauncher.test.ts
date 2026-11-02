import { beforeEach, describe, expect, it, vi } from 'vitest';
import { claudeRemote } from './claudeRemote';
import { claudeRemoteLauncher } from './claudeRemoteLauncher';
import { closeClaudeTurnWithStatus, mapClaudeLogMessageToSessionEnvelopes, type ClaudeSessionProtocolState } from './utils/sessionProtocolMapper';
import { CLAUDE_LOGIN_EXPIRED_MESSAGE } from './utils/providerAuth';
import type { SessionEnvelope } from '@slopus/happy-wire';
import { ensureAttachmentDir, saveAttachmentFiles } from '@/utils/attachmentFiles';

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
vi.mock('@/utils/attachmentFiles', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/utils/attachmentFiles')>(),
    ensureAttachmentDir: vi.fn(async ({ sessionId }: { sessionId: string }) => `/fixture/attachments/${sessionId}`),
    saveAttachmentFiles: vi.fn(async () => [
        { path: '/fixture/attachments/fixture-happy-session/x.png', mimeType: 'image/png', size: 8, isImage: true },
    ]),
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

describe('claudeRemoteLauncher attachments', () => {
    beforeEach(() => { vi.mocked(claudeRemote).mockReset(); });

    it('gives Claude the session attachment folder and a picture as a path in a block array', async () => {
        const { session, stop } = fixture();
        const mode = { permissionMode: 'default' };
        const queued = [{
            message: 'what is this?',
            mode,
            isolate: false,
            hash: 'h',
            attachments: [{ data: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), mimeType: 'image/png', name: 'a.png' }],
        }];
        (session as any).queue = { size: () => 0, waitForMessagesAndGetAsString: vi.fn(async () => queued.shift() ?? null) };
        let first: unknown;
        vi.mocked(claudeRemote).mockImplementation(async opts => {
            first = await opts.nextMessage();
            stop();
        });

        await claudeRemoteLauncher(session as any);

        expect(ensureAttachmentDir).toHaveBeenCalledWith({ sessionId: 'fixture-happy-session' });
        expect(vi.mocked(claudeRemote).mock.calls[0][0].additionalDirectories).toEqual(['/fixture/attachments/fixture-happy-session']);
        expect(saveAttachmentFiles).toHaveBeenCalledWith(
            [expect.objectContaining({ name: 'a.png' })],
            { sessionId: 'fixture-happy-session', rootDir: undefined },
        );
        expect(first).toEqual({
            message: [
                { type: 'text', text: 'what is this?' },
                { type: 'text', text: expect.stringContaining('\n- /fixture/attachments/fixture-happy-session/x.png') },
            ],
            mode,
        });
    });
});