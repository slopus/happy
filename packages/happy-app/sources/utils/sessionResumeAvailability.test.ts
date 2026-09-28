import { describe, expect, it } from 'vitest';
import { resolveSessionResumeAvailability } from './sessionResumeAvailability';

const resumable = {
    isConnected: true,
    hasMachineId: true,
    hasBackendResumeId: true,
    hasMachine: true,
    machineOnline: true,
};

describe('resolveSessionResumeAvailability', () => {
    it('does not restart an already connected worker after its previous turn failed', () => {
        expect(resolveSessionResumeAvailability(resumable)).toBe('hidden');
        expect(resolveSessionResumeAvailability({ ...resumable, isConnected: false })).toBe('available');
    });

    it('keeps connected sessions hidden even without resume metadata', () => {
        expect(resolveSessionResumeAvailability({ ...resumable, hasBackendResumeId: false })).toBe('hidden');
    });

    it('explains why a failed session cannot be resumed', () => {
        const disconnected = { ...resumable, isConnected: false };
        expect(resolveSessionResumeAvailability({ ...disconnected, machineOnline: false })).toBe('machine-offline');
        expect(resolveSessionResumeAvailability({ ...disconnected, hasBackendResumeId: false })).toBe('missing-backend-id');
        expect(resolveSessionResumeAvailability({ ...disconnected, rpcAvailable: false })).toBe('rpc-unavailable');
    });
});
