import { describe, expect, it } from 'vitest';
import { resolveDelegationModel } from './delegationModel';

describe('delegated model selection', () => {
    const choices = [{ code: 'gemini-4-neon', name: 'Gemini 4 Neon' }, { code: 'gpt-6.1-sol', name: 'GPT-6.1 Sol' }];
    it('resolves native IDs and a unique displayed model name', () => {
        expect(resolveDelegationModel('gemini-4-neon', choices).code).toBe('gemini-4-neon');
        expect(resolveDelegationModel('Neon', choices).code).toBe('gemini-4-neon');
        expect(resolveDelegationModel('GPT-6.1 Sol', choices).code).toBe('gpt-6.1-sol');
    });
    it('rejects unknown and ambiguous names rather than silently using another model', () => {
        expect(() => resolveDelegationModel('Argon', choices)).toThrow('unavailable');
        expect(() => resolveDelegationModel('Neon', [...choices, { code: 'other-neon', name: 'Other Neon' }])).toThrow('ambiguous');
    });
});
