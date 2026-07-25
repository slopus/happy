import { describe, it, expect } from 'vitest';
import { UserMessageSchema } from './types';

describe('UserMessageSchema', () => {
    // Regression: zod strips unknown keys, so any meta field the app sends but
    // this schema doesn't declare silently disappears before the backends can
    // read it. `effort` was missing, which made the app's Effort picker a no-op.
    it('preserves meta.effort through parsing', () => {
        const result = UserMessageSchema.safeParse({
            role: 'user',
            content: { type: 'text', text: 'hi' },
            meta: { model: 'gemini-3.1-pro', effort: 'low' }
        });
        expect(result.success).toBe(true);
        expect(result.data?.meta?.effort).toBe('low');
    });

    it('preserves an explicit meta.effort null (reset)', () => {
        const result = UserMessageSchema.safeParse({
            role: 'user',
            content: { type: 'text', text: 'hi' },
            meta: { effort: null }
        });
        expect(result.success).toBe(true);
        expect(result.data?.meta && 'effort' in result.data.meta).toBe(true);
        expect(result.data?.meta?.effort).toBeNull();
    });

    it('omits effort when the app did not send it', () => {
        const result = UserMessageSchema.safeParse({
            role: 'user',
            content: { type: 'text', text: 'hi' },
            meta: { model: 'gemini-3.1-pro' }
        });
        expect(result.success).toBe(true);
        expect(result.data?.meta && 'effort' in result.data.meta).toBe(false);
    });
});
