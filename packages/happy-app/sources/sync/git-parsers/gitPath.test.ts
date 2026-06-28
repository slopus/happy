import { describe, expect, it } from 'vitest';
import { decodeGitPath } from './gitPath';
import { parseNumStat } from './parseDiff';
import { parseStatusSummaryV2 } from './parseStatusV2';

const escapedCyrillic = '"\\320\\234\\320\\236\\320\\235\\320\\225\\320\\242\\320\\230\\320\\227\\320\\220\\320\\246\\320\\230\\320\\257.md"';

describe('git path decoding', () => {
    it('decodes quoted UTF-8 octal paths from git', () => {
        expect(decodeGitPath(escapedCyrillic)).toBe('МОНЕТИЗАЦИЯ.md');
    });

    it('leaves normal paths unchanged', () => {
        expect(decodeGitPath('packages/app/index.ts')).toBe('packages/app/index.ts');
    });

    it('decodes porcelain v2 untracked paths', () => {
        const status = parseStatusSummaryV2(`? ${escapedCyrillic}`);

        expect(status.not_added).toEqual(['МОНЕТИЗАЦИЯ.md']);
    });

    it('decodes numstat paths', () => {
        const diff = parseNumStat(`3\t1\t${escapedCyrillic}`);

        expect(diff.files[0]?.file).toBe('МОНЕТИЗАЦИЯ.md');
    });
});
