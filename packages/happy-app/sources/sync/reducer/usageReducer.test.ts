import { describe, it, expect } from 'vitest';
import { createReducer, reducer } from './reducer';
import type { NormalizedMessage } from '../typesRaw';

function usageMessage(id: string, usage: NormalizedMessage['usage'], createdAt = 1000): NormalizedMessage {
    return {
        id,
        localId: null,
        createdAt,
        role: 'agent',
        isSidechain: false,
        content: [],
        usage,
    };
}

describe('reducer usage processing', () => {
    it('derives contextSize from input + cache tokens', () => {
        const state = createReducer();
        const result = reducer(state, [
            usageMessage('m1', {
                input_tokens: 1000,
                output_tokens: 50,
                cache_creation_input_tokens: 2000,
                cache_read_input_tokens: 3000,
            }),
        ]);

        // contextSize = input + cache_creation + cache_read (output excluded)
        expect(result.usage?.contextSize).toBe(6000);
        expect(result.usage?.inputTokens).toBe(1000);
    });

    it('treats missing cache token fields as zero', () => {
        const state = createReducer();
        const result = reducer(state, [
            usageMessage('m1', { input_tokens: 500, output_tokens: 10 }),
        ]);

        expect(result.usage?.contextSize).toBe(500);
    });

    it('keeps the newest usage by timestamp', () => {
        const state = createReducer();
        reducer(state, [usageMessage('m1', { input_tokens: 100, output_tokens: 1 }, 1000)]);
        reducer(state, [usageMessage('m2', { input_tokens: 9000, output_tokens: 1 }, 2000)]);

        expect(state.latestUsage?.contextSize).toBe(9000);
    });
});
