/**
 * Tests for session operations (ops.ts)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockSessionRPC } = vi.hoisted(() => ({
    mockSessionRPC: vi.fn(),
}));

vi.mock('./apiSocket', () => ({
    apiSocket: {
        sessionRPC: mockSessionRPC,
    }
}));

vi.mock('./sync', () => ({
    sync: {}
}));

import { sessionKill } from './ops';

describe('sessionKill', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('should return success when RPC succeeds', async () => {
        mockSessionRPC.mockResolvedValue({
            success: true,
            message: 'Killing happy-cli process'
        });

        const result = await sessionKill('test-session-123');

        expect(result.success).toBe(true);
        expect(mockSessionRPC).toHaveBeenCalledWith(
            'test-session-123',
            'killSession',
            {}
        );
    });

    it('should return success when RPC fails because process already exited (regression #687)', async () => {
        mockSessionRPC.mockRejectedValue(new Error('RPC call failed'));

        const result = await sessionKill('dead-session-456');

        expect(result.success).toBe(true);
        expect(result.message).toBe('Session already stopped');
    });

    it('should return success even on non-Error RPC failures', async () => {
        mockSessionRPC.mockRejectedValue('timeout');

        const result = await sessionKill('dead-session-789');

        expect(result.success).toBe(true);
        expect(result.message).toBe('Session already stopped');
    });
});
