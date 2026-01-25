import { describe, expect, it } from 'vitest';
import { normalizeCapabilityProbeError } from './normalizeCapabilityProbeError';

describe('normalizeCapabilityProbeError', () => {
    it('normalizes Error-like objects', () => {
        expect(normalizeCapabilityProbeError(new Error('boom'))).toEqual({ message: 'boom' });
        expect(normalizeCapabilityProbeError({ message: 'nope' })).toEqual({ message: 'nope' });
    });

    it('normalizes strings', () => {
        expect(normalizeCapabilityProbeError('fail')).toEqual({ message: 'fail' });
    });

    it('stringifies unknown values', () => {
        expect(normalizeCapabilityProbeError(null)).toEqual({ message: 'null' });
    });
});
