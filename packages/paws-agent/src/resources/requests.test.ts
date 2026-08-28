import { describe, expect, it, vi } from 'vitest';
import { RequestsResourceImpl } from './requests';

describe('RequestsResource', () => {
    it('uses the existing encrypted session permission RPC', async () => {
        const realtime = { sessionRpc: vi.fn().mockResolvedValue(undefined) };
        const sessions = {
            get: vi.fn().mockResolvedValue({ agentState: { requests: { 'request-1': { tool: 'Bash' } } } }),
        };
        const requests = new RequestsResourceImpl(realtime as never, sessions as never);

        await requests.approve({ sessionId: 'session-1', requestId: 'request-1' });
        await requests.reject({ sessionId: 'session-1', requestId: 'request-1' });

        expect(realtime.sessionRpc).toHaveBeenNthCalledWith(1, 'session-1', 'permission', {
            id: 'request-1', approved: true,
        });
        expect(realtime.sessionRpc).toHaveBeenNthCalledWith(2, 'session-1', 'permission', {
            id: 'request-1', approved: false,
        });
    });

    it('rejects a stale request without sending RPC', async () => {
        const realtime = { sessionRpc: vi.fn() };
        const sessions = { get: vi.fn().mockResolvedValue({ agentState: { requests: {} } }) };
        const requests = new RequestsResourceImpl(realtime as never, sessions as never);
        await expect(requests.approve({ sessionId: 's', requestId: 'missing' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
        expect(realtime.sessionRpc).not.toHaveBeenCalled();
    });
});
