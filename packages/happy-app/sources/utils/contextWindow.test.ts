import { describe, it, expect } from 'vitest';
import {
    DEFAULT_MAX_CONTEXT_SIZE,
    ONE_MILLION_CONTEXT_SIZE,
    maxContextSizeForModel,
} from './contextWindow';

describe('maxContextSizeForModel', () => {
    it('returns the 1M window for models tagged with the [1m] suffix', () => {
        expect(maxContextSizeForModel('claude-opus-4-8[1m]')).toBe(ONE_MILLION_CONTEXT_SIZE);
        expect(maxContextSizeForModel('claude-sonnet-4-6[1m]')).toBe(1000000);
    });

    it('returns the default 190K window for standard models', () => {
        expect(maxContextSizeForModel('claude-opus-4-8')).toBe(DEFAULT_MAX_CONTEXT_SIZE);
        expect(maxContextSizeForModel('claude-haiku-4-5-20251001')).toBe(190000);
    });

    it('falls back to the default window when the model id is unknown', () => {
        expect(maxContextSizeForModel(undefined)).toBe(DEFAULT_MAX_CONTEXT_SIZE);
        expect(maxContextSizeForModel('')).toBe(DEFAULT_MAX_CONTEXT_SIZE);
    });
});
