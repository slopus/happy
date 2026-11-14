import { describe, expect, it } from 'vitest';
import { isClaudeEffort } from './effort';

describe('isClaudeEffort', () => {
    it('accepts every level Claude Code takes for --effort, including ultracode', () => {
        for (const level of ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode']) {
            expect(isClaudeEffort(level)).toBe(true);
        }
    });

    it('rejects unknown, missing and non-string values', () => {
        expect(isClaudeEffort('bogus')).toBe(false);
        expect(isClaudeEffort('')).toBe(false);
        expect(isClaudeEffort(undefined)).toBe(false);
        expect(isClaudeEffort(null)).toBe(false);
        expect(isClaudeEffort(3)).toBe(false);
    });
});
