import { describe, expect, it } from 'vitest';

import { parseParenIdentifier } from './parseParenIdentifier';

describe('parseParenIdentifier', () => {
    it('parses a name(spec) identifier', () => {
        expect(parseParenIdentifier('Bash(echo hello)')).toEqual({ name: 'Bash', spec: 'echo hello' });
    });

    it('returns null when value does not contain parentheses', () => {
        expect(parseParenIdentifier('Bash')).toBeNull();
    });
});

