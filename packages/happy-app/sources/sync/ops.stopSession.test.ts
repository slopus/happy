import { beforeEach, describe, expect, it, vi } from 'vitest';

const { machineRPC } = vi.hoisted(() => ({
    machineRPC: vi.fn(),
}));

vi.mock('./apiSocket', () => ({ apiSocket: { machineRPC } }));
vi.mock('./sync', () => ({ sync: {} }));
vi.mock('./storage', () => ({ storage: { getState: () => ({ sessions: {} }) } }));

import { machineStopSession } from './ops';

describe('machine stop-session', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('reports a stop the daemon made', async () => {
        machineRPC.mockResolvedValue({ message: 'Session stopped' });
        expect(await machineStopSession('machine-1', 'session-1')).toEqual({ success: true, message: 'Session stopped' });
        expect(machineRPC).toHaveBeenCalledWith('machine-1', 'stop-session', { sessionId: 'session-1' });
    });

    it('reports the encrypted daemon error as a failed stop, so callers fall back', async () => {
        machineRPC.mockResolvedValue({ error: 'Session not found or failed to stop' });
        expect(await machineStopSession('machine-1', 'session-1')).toEqual({
            success: false, message: 'Session not found or failed to stop',
        });
    });

    it('reports a call that never reached the daemon as a failed stop', async () => {
        machineRPC.mockRejectedValue(new Error('The computer did not respond'));
        expect(await machineStopSession('machine-1', 'session-1')).toEqual({
            success: false, message: 'The computer did not respond',
        });
    });
});
