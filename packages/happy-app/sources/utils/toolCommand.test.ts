import { describe, expect, it } from 'vitest';
import { stringifyToolCommand } from './toolCommand';

describe('stringifyToolCommand', () => {
    it('returns plain string commands unchanged', () => {
        expect(stringifyToolCommand('ls -la')).toBe('ls -la');
    });

    it('unwraps shell wrapper command arrays', () => {
        expect(stringifyToolCommand(['/bin/zsh', '-lc', 'rg -n "test" .'])).toBe('rg -n "test" .');
        expect(stringifyToolCommand(['bash', '-c', 'pwd'])).toBe('pwd');
    });

    it('joins non-wrapper command arrays', () => {
        expect(stringifyToolCommand(['git', 'status', '--short'])).toBe('git status --short');
    });

    it('returns null for empty or unsupported values', () => {
        expect(stringifyToolCommand('   ')).toBeNull();
        expect(stringifyToolCommand([])).toBeNull();
        expect(stringifyToolCommand(null)).toBeNull();
    });
});
