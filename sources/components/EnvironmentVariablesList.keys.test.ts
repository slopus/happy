import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('EnvironmentVariablesList item keys', () => {
    it('does not key EnvironmentVariableCard by array index', () => {
        const file = join(process.cwd(), 'sources/components/EnvironmentVariablesList.tsx');
        const content = readFileSync(file, 'utf8');

        expect(content).not.toContain('key={index}');
        expect(content).toContain('key={envVar.name}');
    });
});

