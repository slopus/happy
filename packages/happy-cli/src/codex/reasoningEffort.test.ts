import { describe, expect, it } from 'vitest';
import { isReasoningEffort } from './reasoningEffort';

describe('remote Codex effort validation', () => {
    it.each(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'])('preserves the %s override instead of falling back to defaults', (effort) => {
        const previousEffort = 'medium';
        const resolved = isReasoningEffort(effort) ? effort : previousEffort;
        expect(resolved).toBe(effort);
    });

    it.each([null, undefined, '', 'MAX', 'unknown', 1, {}, ['max']])('rejects malformed overrides (%j)', (effort) => {
        expect(isReasoningEffort(effort)).toBe(false);
    });
});
