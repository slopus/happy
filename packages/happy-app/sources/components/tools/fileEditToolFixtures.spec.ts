import { describe, expect, it } from 'vitest';
import { fileEditToolFixtures } from './fileEditToolFixtures';

describe('file edit chat preview fixtures', () => {
    it('uses Claude Opus Edit arguments without adapting the mobile payload', () => {
        const fixture = fileEditToolFixtures[0];

        expect(fixture.sourceName).toBe('Edit');
        expect(fixture.tool.name).toBe('Edit');
        expect(fixture.tool.input).toBe(fixture.sourceArguments);
        expect(Object.keys(fixture.tool.input)).toEqual([
            'file_path',
            'old_string',
            'new_string',
            'replace_all',
        ]);
    });

    it('represents Happy Agent apply_patch as the CodexPatch paired-content contract', () => {
        const fixture = fileEditToolFixtures[1];
        const sourcePatch = fixture.sourceArguments.patch;
        const change = fixture.tool.input.changes['sources/components/Composer.tsx'];

        expect(fixture.sourceName).toBe('apply_patch');
        expect(sourcePatch).toContain('*** Begin Patch');
        expect(fixture.tool.name).toBe('CodexPatch');
        expect(fixture.tool.input).not.toHaveProperty('patch');
        expect(change).toEqual({
            kind: { move_path: null, type: 'update' },
            modify: {
                old_content: expect.any(String),
                new_content: expect.any(String),
            },
        });
    });
});
