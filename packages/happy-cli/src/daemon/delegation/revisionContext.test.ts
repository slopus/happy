import { describe, expect, it } from 'vitest';
import { delegationRevisionContext, DELEGATION_REVISION_CONTEXT_LIMIT } from './revisionContext';
import type { StoredDelegationVersion } from './store';

const version = (number: number, text = `Result ${number}`): StoredDelegationVersion => ({
    version: number, requestId: `request-${number}`, inputHash: 'a'.repeat(64), phase: 'sent', reportSequence: 2,
    prompt: `Instruction ${number}`, context: `Facts ${number}`, result: { text }, status: 'completed', startedAt: 1, updatedAt: 2,
});

describe('saved delegation revision context', () => {
    it('contains chronological instructions and results, and accurately describes a new executor', () => {
        const context = delegationRevisionContext([version(1), version(2)]);
        expect(context).toContain('Instruction 1'); expect(context).toContain('Facts 2'); expect(context).toContain('Result 2');
        expect(context.indexOf('Result 1')).toBeLessThan(context.indexOf('Result 2'));
        expect(context).toContain('native tool history was not restored');
        expect(delegationRevisionContext([])).toBe('');
    });

    it('bounds worst-case escaped fields and keeps the original and newest revision with explicit omissions', () => {
        const history = Array.from({ length: 99 }, (_, index) => ({
            ...version(index + 1, `LATEST-${index + 1}${'\u0000'.repeat(200_000)}`),
            prompt: `INSTRUCTION-${index + 1}${'\u0000'.repeat(100_000)}`, context: '\u0000'.repeat(100_000),
        }));
        const result = delegationRevisionContext(history);
        expect(result.length).toBeLessThanOrEqual(DELEGATION_REVISION_CONTEXT_LIMIT);
        expect(result).toContain('INSTRUCTION-1'); expect(result).toContain('LATEST-99');
        expect(result).toContain('records omitted'); expect(result).toContain('Saved field shortened');
    });
});
