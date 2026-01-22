import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import { supportsVendorResume } from './agentCapabilities';

describe('supportsVendorResume', () => {
    const prev = process.env.HAPPY_EXPERIMENTAL_CODEX_RESUME;

    beforeEach(() => {
        delete process.env.HAPPY_EXPERIMENTAL_CODEX_RESUME;
    });

    afterEach(() => {
        if (typeof prev === 'string') process.env.HAPPY_EXPERIMENTAL_CODEX_RESUME = prev;
        else delete process.env.HAPPY_EXPERIMENTAL_CODEX_RESUME;
    });

    it('allows Claude by default', () => {
        expect(supportsVendorResume('claude')).toBe(true);
    });

    it('rejects Codex by default', () => {
        expect(supportsVendorResume('codex')).toBe(false);
    });

    it('allows Codex when explicitly enabled for this spawn', () => {
        expect(supportsVendorResume('codex', { allowExperimentalCodex: true })).toBe(true);
    });

    it('allows Codex when HAPPY_EXPERIMENTAL_CODEX_RESUME is set', () => {
        process.env.HAPPY_EXPERIMENTAL_CODEX_RESUME = '1';
        expect(supportsVendorResume('codex')).toBe(true);
    });
});

