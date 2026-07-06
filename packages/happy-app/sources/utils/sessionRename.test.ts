import { describe, it, expect } from 'vitest';
import { resolveSessionRename } from './sessionRename';

describe('resolveSessionRename', () => {
    it('returns null when the prompt was cancelled', () => {
        expect(resolveSessionRename(null, 'Old title')).toBeNull();
    });

    it('returns null for empty or whitespace-only input', () => {
        expect(resolveSessionRename('', 'Old title')).toBeNull();
        expect(resolveSessionRename('   ', 'Old title')).toBeNull();
    });

    it('returns null when the trimmed title is unchanged', () => {
        expect(resolveSessionRename('Old title', 'Old title')).toBeNull();
        expect(resolveSessionRename('  Old title  ', 'Old title')).toBeNull();
    });

    it('returns the trimmed title when it differs', () => {
        expect(resolveSessionRename('  New title  ', 'Old title')).toBe('New title');
        expect(resolveSessionRename('New title', '')).toBe('New title');
    });
});
