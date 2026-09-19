import { describe, expect, it } from 'vitest';
import { resolveSessionResumeAvailability } from './sessionResumeAvailability';

const resumable = {
    isConnected: true,
    hasFailedTurn: true,
    hasMachineId: true,
    hasBackendResumeId: true,
    hasMachine: true,
    machineOnline: true,
};

describe('resolveSessionResumeAvailability', () => {
    it('exposes recovery for a failed turn even while transport presence is online', () => {
        expect(resolveSessionResumeAvailability(resumable)).toBe('available');
    });

    it('keeps healthy connected sessions hidden', () => {
        expect(resolveSessionResumeAvailability({ ...resumable, hasFailedTurn: false })).toBe('hidden');
    });

    it('explains why a failed session cannot be resumed', () => {
        expect(resolveSessionResumeAvailability({ ...resumable, machineOnline: false })).toBe('machine-offline');
        expect(resolveSessionResumeAvailability({ ...resumable, hasBackendResumeId: false })).toBe('missing-backend-id');
        expect(resolveSessionResumeAvailability({ ...resumable, rpcAvailable: false })).toBe('rpc-unavailable');
    });
});
