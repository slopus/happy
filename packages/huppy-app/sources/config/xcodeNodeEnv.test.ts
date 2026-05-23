import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Xcode Node environment', () => {
    it('avoids pinning Xcode script phases to a versioned Homebrew Cellar node path', () => {
        const xcodeEnvLocal = readFileSync(resolve(process.cwd(), 'ios/.xcode.env.local'), 'utf8');

        expect(xcodeEnvLocal).not.toContain('/Cellar/node@');
        expect(xcodeEnvLocal).toContain('NODE_BINARY=');
    });
});
