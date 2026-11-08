import { describe, expect, it } from 'vitest';
import { parseSessionFileLink, resolveSessionFilePath, splitSessionFileText } from './sessionFileLinks';

describe('sessionFileLinks', () => {
    const sessionRoot = '/Users/kirilldubovitskiy/projects/happy';

    it('parses absolute file refs with line numbers', () => {
        const result = parseSessionFileLink('/Users/kirilldubovitskiy/projects/happy/packages/happy-cli/src/codex/runCodex.ts:594', {
            sessionRoot,
        });

        expect(result).toEqual({
            path: '/Users/kirilldubovitskiy/projects/happy/packages/happy-cli/src/codex/runCodex.ts',
            absolutePath: '/Users/kirilldubovitskiy/projects/happy/packages/happy-cli/src/codex/runCodex.ts',
            relativePath: 'packages/happy-cli/src/codex/runCodex.ts',
            withinSessionRoot: true,
            line: 594,
            column: null,
        });
    });

    it('parses relative file refs with line and column numbers', () => {
        const result = parseSessionFileLink('packages/happy-cli/src/codex/runCodex.ts:594:2', {
            sessionRoot,
        });

        expect(result).toEqual({
            path: 'packages/happy-cli/src/codex/runCodex.ts',
            absolutePath: '/Users/kirilldubovitskiy/projects/happy/packages/happy-cli/src/codex/runCodex.ts',
            relativePath: 'packages/happy-cli/src/codex/runCodex.ts',
            withinSessionRoot: true,
            line: 594,
            column: 2,
        });
    });

    it('rejects external urls', () => {
        expect(parseSessionFileLink('https://openai.com', { sessionRoot })).toBeNull();
        expect(parseSessionFileLink('mailto:test@example.com', { sessionRoot })).toBeNull();
    });

    it('splits bare text into plain and linked segments', () => {
        const result = splitSessionFileText('Open packages/happy-cli/src/codex/runCodex.ts:594 please.', sessionRoot);

        expect(result).toEqual([
            { text: 'Open ', link: null },
            {
                text: 'packages/happy-cli/src/codex/runCodex.ts:594',
                link: {
                    path: 'packages/happy-cli/src/codex/runCodex.ts',
                    absolutePath: '/Users/kirilldubovitskiy/projects/happy/packages/happy-cli/src/codex/runCodex.ts',
                    relativePath: 'packages/happy-cli/src/codex/runCodex.ts',
                    withinSessionRoot: true,
                    line: 594,
                    column: null,
                },
            },
            { text: ' please.', link: null },
        ]);
    });

    it('splits absolute bare file refs with spaces into linked segments', () => {
        const result = splitSessionFileText(
            'Image: /Users/kirilldubovitskiy/Library/Application Support/CleanShot/media/test/CleanShot 2026-03-19 at 00.54.37@2x.png',
            sessionRoot,
        );

        expect(result).toEqual([
            { text: 'Image: ', link: null },
            {
                text: '/Users/kirilldubovitskiy/Library/Application Support/CleanShot/media/test/CleanShot 2026-03-19 at 00.54.37@2x.png',
                link: {
                    path: '/Users/kirilldubovitskiy/Library/Application Support/CleanShot/media/test/CleanShot 2026-03-19 at 00.54.37@2x.png',
                    absolutePath: '/Users/kirilldubovitskiy/Library/Application Support/CleanShot/media/test/CleanShot 2026-03-19 at 00.54.37@2x.png',
                    relativePath: null,
                    withinSessionRoot: false,
                    line: null,
                    column: null,
                },
            },
        ]);
    });

    it('does not turn version numbers into file refs', () => {
        expect(splitSessionFileText('Version 1.2.3 shipped.', sessionRoot)).toEqual([
            { text: 'Version 1.2.3 shipped.', link: null },
        ]);
    });

    it('does not turn slash-separated prose into file refs', () => {
        expect(splitSessionFileText(
            'Codex then starts/resumes turns with the selected model and effort. I’m checking CLI docs/tests to confirm the happy codex --model/--effort surface is wired end to end.',
            sessionRoot,
        )).toEqual([
            {
                text: 'Codex then starts/resumes turns with the selected model and effort. I’m checking CLI docs/tests to confirm the happy codex --model/--effort surface is wired end to end.',
                link: null,
            },
        ]);
    });

    it('resolves viewer input to an absolute path', () => {
        expect(resolveSessionFilePath('packages/happy-app/README.md', sessionRoot)).toEqual({
            path: 'packages/happy-app/README.md',
            absolutePath: '/Users/kirilldubovitskiy/projects/happy/packages/happy-app/README.md',
            relativePath: 'packages/happy-app/README.md',
            withinSessionRoot: true,
            line: null,
            column: null,
        });
    });
});

it('keeps separate code-block lines as distinct file references', () => {
    const segments = splitSessionFileText('docs/产品方案.md\ndemo/index.html', '/workspace');
    expect(segments.filter(segment => segment.link).map(segment => segment.link!.path)).toEqual(['docs/产品方案.md', 'demo/index.html']);
    expect(segments.map(segment => segment.text).join('')).toBe('docs/产品方案.md\ndemo/index.html');
});
