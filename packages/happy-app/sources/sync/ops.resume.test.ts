import { beforeEach, describe, expect, it, vi } from 'vitest';

const { machineRPC, getSessionDataKey, state } = vi.hoisted(() => ({
    machineRPC: vi.fn(),
    getSessionDataKey: vi.fn(),
    state: { sessions: {} as Record<string, any> },
}));

vi.mock('./apiSocket', () => ({ apiSocket: { machineRPC } }));
vi.mock('./sync', () => ({ sync: { encryption: { getSessionDataKey } } }));
vi.mock('./storage', () => ({ storage: { getState: () => state } }));

import { machineResumeSession } from './ops';

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