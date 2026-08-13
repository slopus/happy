import { describe, expect, it } from 'vitest';
import { UserMessageSchema } from './types';

describe('UserMessageSchema', () => {
    it('preserves message effort metadata for runtime model selection', () => {
        const parsed = UserMessageSchema.parse({
            role: 'user',
            content: {
                type: 'text',
                text: 'use maximum effort',
            },
            meta: {
                sentFrom: 'web',
                appendSystemPrompt: 'focus on correctness',
                effort: 'max',
            },
        });

        expect(parsed.meta).toMatchObject({
            sentFrom: 'web',
            appendSystemPrompt: 'focus on correctness',
            effort: 'max',
        });
    });

    it('preserves null effort metadata so callers can reset the override', () => {
        const parsed = UserMessageSchema.parse({
            role: 'user',
            content: {
                type: 'text',
                text: 'reset effort',
            },
            meta: {
                effort: null,
            },
        });

        expect(parsed.meta?.effort).toBeNull();
    });
});
