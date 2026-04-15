import { describe, it, expect } from 'vitest';
import { splitPathForSuggestions } from './useDirSuggestions.utils';

const HOME = '/home/steve';

describe('splitPathForSuggestions', () => {
    describe('tilde paths (the regression case)', () => {
        it('expands `~/proj` parent to home dir', () => {
            const r = splitPathForSuggestions('~/proj', HOME);
            expect(r.parentDir).toBe('~/');
            expect(r.resolvedParentDir).toBe('/home/steve/');
            expect(r.prefix).toBe('proj');
        });

        it('expands `~/projects/hap` parent through nested dir', () => {
            const r = splitPathForSuggestions('~/projects/hap', HOME);
            expect(r.parentDir).toBe('~/projects/');
            expect(r.resolvedParentDir).toBe('/home/steve/projects/');
            expect(r.prefix).toBe('hap');
        });

        it('preserves `~/` parent when nothing typed after slash', () => {
            const r = splitPathForSuggestions('~/', HOME);
            expect(r.parentDir).toBe('~/');
            expect(r.resolvedParentDir).toBe('/home/steve/');
            expect(r.prefix).toBe('');
        });

        it('treats bare `~` as prefix under root (degenerate but shouldn\'t crash)', () => {
            const r = splitPathForSuggestions('~', HOME);
            expect(r.parentDir).toBe('/');
            expect(r.resolvedParentDir).toBe('/');
            expect(r.prefix).toBe('~');
        });
    });

    describe('absolute paths', () => {
        it('splits `/home/h` into / + h', () => {
            const r = splitPathForSuggestions('/home/h', HOME);
            expect(r.parentDir).toBe('/home/');
            expect(r.resolvedParentDir).toBe('/home/');
            expect(r.prefix).toBe('h');
        });

        it('splits `/usr/local/b` into /usr/local/ + b', () => {
            const r = splitPathForSuggestions('/usr/local/b', HOME);
            expect(r.parentDir).toBe('/usr/local/');
            expect(r.resolvedParentDir).toBe('/usr/local/');
            expect(r.prefix).toBe('b');
        });

        it('handles bare `/` with no prefix', () => {
            const r = splitPathForSuggestions('/', HOME);
            expect(r.parentDir).toBe('/');
            expect(r.resolvedParentDir).toBe('/');
            expect(r.prefix).toBe('');
        });
    });

    describe('relative / no-slash input', () => {
        it('falls back to / as parent and uses input as prefix', () => {
            const r = splitPathForSuggestions('proj', HOME);
            expect(r.parentDir).toBe('/');
            expect(r.resolvedParentDir).toBe('/');
            expect(r.prefix).toBe('proj');
        });
    });

    describe('without homeDir (machine offline / metadata missing)', () => {
        it('leaves `~/` unexpanded — caller will see stale lookup, not a crash', () => {
            const r = splitPathForSuggestions('~/proj', undefined);
            expect(r.parentDir).toBe('~/');
            expect(r.resolvedParentDir).toBe('~/');
            expect(r.prefix).toBe('proj');
        });

        it('absolute paths still work without homeDir', () => {
            const r = splitPathForSuggestions('/home/h', undefined);
            expect(r.parentDir).toBe('/home/');
            expect(r.resolvedParentDir).toBe('/home/');
            expect(r.prefix).toBe('h');
        });
    });

    describe('Windows home dir', () => {
        it('expands ~ against a Windows-style homeDir', () => {
            const r = splitPathForSuggestions('~/proj', 'C:\\Users\\steve');
            expect(r.parentDir).toBe('~/');
            // resolveAbsolutePath uses backslash when homeDir uses backslash
            expect(r.resolvedParentDir).toBe('C:\\Users\\steve\\');
            expect(r.prefix).toBe('proj');
        });
    });
});
