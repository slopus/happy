import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const componentsDirectory = dirname(fileURLToPath(import.meta.url));

function getCopyMenuRowStyleBlock(source: string): string {
    const match = source.match(/copyMenuRow:\s*{([\s\S]*?)\n\s*},/);

    expect(match).not.toBeNull();

    return match?.[1] ?? '';
}

describe('SessionPreviewSheet copy menu layering', () => {
    it('keeps the menu row above the arrow so the divider stays visible', () => {
        const source = readFileSync(
            join(componentsDirectory, 'SessionPreviewSheet.tsx'),
            'utf8',
        );

        expect(getCopyMenuRowStyleBlock(source)).toMatch(/zIndex:\s*1\b/);
    });
});
