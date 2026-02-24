import { describe, expect, it } from 'vitest';
import { ApiEphemeralUpdateSchema } from './apiTypes';

describe('ApiEphemeralUpdateSchema usage payload compatibility', () => {
    it('accepts usage payload with only total cost and extra token keys', () => {
        const payload = {
            type: 'usage',
            id: 'cmm0hpt8a0spmo814lvmt5jpt',
            key: 'codex-session',
            timestamp: 1771931751300,
            tokens: {
                cache_creation: 0,
                cache_read: 0,
                input: 158616,
                output: 126,
                reasoning: 0,
                total: 158742,
            },
            cost: {
                total: 0,
            },
        };

        const parsed = ApiEphemeralUpdateSchema.safeParse(payload);

        expect(parsed.success).toBe(true);
        if (!parsed.success) {
            throw new Error(parsed.error.message);
        }
        expect(parsed.data.type).toBe('usage');
        if (parsed.data.type !== 'usage') {
            throw new Error('Expected usage update');
        }
        expect(parsed.data.cost.total).toBe(0);
        expect(parsed.data.tokens.total).toBe(158742);
    });

    it('accepts usage payload with detailed cost keys', () => {
        const payload = {
            type: 'usage',
            id: 'session-1',
            key: 'claude-session',
            timestamp: 1771931751300,
            tokens: {
                total: 100,
                input: 80,
                output: 20,
                cache_creation: 0,
                cache_read: 0,
            },
            cost: {
                total: 0.5,
                input: 0.4,
                output: 0.1,
            },
        };

        const parsed = ApiEphemeralUpdateSchema.safeParse(payload);
        expect(parsed.success).toBe(true);
    });
});
