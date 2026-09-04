import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAppPromptDedupe } from './appPromptDedupe';

describe('createAppPromptDedupe', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('consumes an exact match exactly once', () => {
        const dedupe = createAppPromptDedupe();
        dedupe.record('hello');
        expect(dedupe.consume('hello')).toBe(true);
        // Consumed entries are removed, so an identical terminal-typed
        // prompt still gets forwarded afterwards.
        expect(dedupe.consume('hello')).toBe(false);
    });

    it('matches when the SDK echoes the prompt with a trailing newline', () => {
        // Regression: the app sends "fix it" and the JSONL scanner sees
        // "fix it\n" — the exact-match dedupe used to miss this and the
        // app-sent prompt was persisted twice on the server.
        const dedupe = createAppPromptDedupe();
        dedupe.record('fix it');
        expect(dedupe.consume('fix it\n')).toBe(true);
    });

    it('normalizes whitespace on both sides', () => {
        const dedupe = createAppPromptDedupe();
        dedupe.record('  spaced prompt  ');
        expect(dedupe.consume('\tspaced prompt\n')).toBe(true);
    });

    it('does not consume text that was never recorded', () => {
        const dedupe = createAppPromptDedupe();
        dedupe.record('one');
        expect(dedupe.consume('two')).toBe(false);
    });

    it('expires entries older than the max age', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
        const dedupe = createAppPromptDedupe(5 * 60 * 1000);
        dedupe.record('stale');
        vi.setSystemTime(new Date('2026-01-01T00:06:00Z'));
        expect(dedupe.consume('stale')).toBe(false);
    });

    it('keeps entries within the max age', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
        const dedupe = createAppPromptDedupe(5 * 60 * 1000);
        dedupe.record('fresh');
        vi.setSystemTime(new Date('2026-01-01T00:04:00Z'));
        expect(dedupe.consume('fresh')).toBe(true);
    });
});
