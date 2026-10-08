import { beforeEach, describe, expect, it, vi } from 'vitest';

const { machineRPC, sessionRPC, request, getSessionDataKey, state } = vi.hoisted(() => ({
    machineRPC: vi.fn(),
    sessionRPC: vi.fn(), request: vi.fn(),
    getSessionDataKey: vi.fn(),
    state: { sessions: {} as Record<string, any> },
}));

vi.mock('./apiSocket', () => ({ apiSocket: { machineRPC, sessionRPC, request } }));
vi.mock('./sync', () => ({ sync: { encryption: { getSessionDataKey } } }));
vi.mock('./storage', () => ({ storage: { getState: () => state } }));

import { machineResumeSession, sessionArchive } from './ops';

describe('machine resume fallback', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        state.sessions = {
            'session-1': {
                metadata: { path: '/project', machineId: 'machine-1', claudeSessionId: 'claude-1' },
                metadataVersion: 3, agentStateVersion: 4, seq: 12,
            },
        };
        getSessionDataKey.mockReturnValue(new Uint8Array(32).fill(1));
        machineRPC.mockResolvedValue({ type: 'success', sessionId: 'session-1' });
    });

    it('sends only the requested session data key and metadata to its owning machine', async () => {
        const result = await machineResumeSession({ machineId: 'machine-1', sessionId: 'session-1' });
        expect(result).toEqual({ type: 'success', sessionId: 'session-1' });
        expect(getSessionDataKey).toHaveBeenCalledWith('session-1');
        expect(machineRPC).toHaveBeenCalledWith('machine-1', 'resume-happy-session', expect.objectContaining({
            sessionId: 'session-1', fallbackReason: 'ok',
            fallback: { ...state.sessions['session-1'], encryptionVariant: 'dataKey', encryptionKey: Buffer.alloc(32, 1).toString('base64') },
        }));
    });

    it.each(['another-machine', undefined])('withholds the key if session ownership does not match (%s)', async (machineId) => {
        state.sessions['session-1'].metadata.machineId = machineId;
        await machineResumeSession({ machineId: 'machine-1', sessionId: 'session-1' });
        expect(getSessionDataKey).not.toHaveBeenCalled();
        expect(machineRPC.mock.calls[0][2].fallback).toBeUndefined();
    });

    it('keeps legacy sessions on the tracked path without exporting a master key', async () => {
        getSessionDataKey.mockReturnValue(null);
        await machineResumeSession({ machineId: 'machine-1', sessionId: 'session-1' });
        expect(machineRPC.mock.calls[0][2]).toMatchObject({ fallback: undefined, fallbackReason: 'client-has-no-data-key' });
    });

    it('surfaces the encrypted daemon error in the result shape the resume UI handles', async () => {
        machineRPC.mockResolvedValue({ error: 'Legacy sessions can only be resumed while tracked.' });
        expect(await machineResumeSession({ machineId: 'machine-1', sessionId: 'session-1' })).toEqual({
            type: 'error', errorMessage: 'Legacy sessions can only be resumed while tracked.',
        });
    });

    it('does not substitute another session when the requested row is missing', async () => {
        await machineResumeSession({ machineId: 'machine-1', sessionId: 'missing' });
        expect(getSessionDataKey).not.toHaveBeenCalled();
        expect(machineRPC.mock.calls[0][2]).toMatchObject({ fallback: undefined, fallbackReason: 'client-has-no-session-row' });
    });
});

describe('native Codex archive', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        state.sessions = { c: { active: true, metadata: { codexThreadId: 'native', machineId: 'machine' } } };
        sessionRPC.mockResolvedValue({ success: true });
        request.mockResolvedValue({ ok: true });
    });
    it('stops the Happy writer and archives Codex before deactivating the mirror', async () => {
        machineRPC.mockResolvedValue({ success: true });
        expect(await sessionArchive('c')).toEqual({ success: true });
        expect(machineRPC).toHaveBeenCalledWith('machine', 'codex-set-archive', { sessionId: 'c', threadId: 'native', archived: true });
        expect(sessionRPC.mock.invocationCallOrder[0]).toBeLessThan(machineRPC.mock.invocationCallOrder[0]);
        expect(machineRPC.mock.invocationCallOrder[0]).toBeLessThan(request.mock.invocationCallOrder[0]);
    });
    it('does not create a Happy-only archive when Codex rejects the operation', async () => {
        machineRPC.mockResolvedValue({ error: 'active writer' });
        expect(await sessionArchive('c')).toEqual({ success: false, message: 'active writer' });
        expect(request).not.toHaveBeenCalled();
    });
});
