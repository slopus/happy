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

    it('returns the 1M window for Fable/Mythos (1M is their only window)', () => {
        expect(maxContextSizeForModel('fable')).toBe(ONE_MILLION_CONTEXT_SIZE);
        expect(maxContextSizeForModel('claude-fable-5')).toBe(ONE_MILLION_CONTEXT_SIZE);
        expect(maxContextSizeForModel('claude-mythos-5')).toBe(ONE_MILLION_CONTEXT_SIZE);
    });

    it('returns the 1M window for the bare opus/sonnet aliases (latest = 1M)', () => {
        expect(maxContextSizeForModel('opus')).toBe(ONE_MILLION_CONTEXT_SIZE);
        expect(maxContextSizeForModel('sonnet')).toBe(ONE_MILLION_CONTEXT_SIZE);
    });

    it('returns the 1M window for models that always run 1M on the Anthropic API', () => {
        expect(maxContextSizeForModel('claude-opus-4-8')).toBe(ONE_MILLION_CONTEXT_SIZE);
        expect(maxContextSizeForModel('claude-opus-4-7')).toBe(ONE_MILLION_CONTEXT_SIZE);
        expect(maxContextSizeForModel('claude-sonnet-5')).toBe(ONE_MILLION_CONTEXT_SIZE);
    });

    it('returns the default 190K window for models that need the [1m] opt-in', () => {
        // Older versions default to 200K and require the [1m] suffix for 1M.
        expect(maxContextSizeForModel('claude-opus-4-6')).toBe(DEFAULT_MAX_CONTEXT_SIZE);
        expect(maxContextSizeForModel('claude-sonnet-4-6')).toBe(DEFAULT_MAX_CONTEXT_SIZE);
    });

    it('returns the default 190K window for 200K-capped and unknown models', () => {
        expect(maxContextSizeForModel('haiku')).toBe(DEFAULT_MAX_CONTEXT_SIZE);
        expect(maxContextSizeForModel('claude-haiku-4-5-20251001')).toBe(190000);
        expect(maxContextSizeForModel('default')).toBe(DEFAULT_MAX_CONTEXT_SIZE);
    });

    it('falls back to the default window when the model id is unknown', () => {
        expect(maxContextSizeForModel(undefined)).toBe(DEFAULT_MAX_CONTEXT_SIZE);
        expect(maxContextSizeForModel('')).toBe(DEFAULT_MAX_CONTEXT_SIZE);
    });
});
