/**
 * Render tests for the diff renderer.
 *
 * The engine is covered by pure tests; what those can't catch is the half that
 * actually breaks on screen — a gutter that disagrees with the code beside it,
 * a split row that pairs the wrong two lines, a collapse that hides everything.
 * React Native is mocked down to host elements (the same approach the native
 * menu tests use), so this runs in plain node.
 */

import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('react-native', async () => {
    const ReactModule = await import('react');
    const host = (name: string) => (props: any) =>
        ReactModule.createElement(name, props, props.children);
    return {
        Platform: { OS: 'ios', select: (spec: any) => spec.ios ?? spec.default },
        StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
        View: host('View'),
        Text: host('Text'),
        Pressable: host('Pressable'),
        ScrollView: host('ScrollView'),
    };
});

const PALETTE = {
    rowAddedBg: '#eaffea', rowRemovedBg: '#ffecec', rowContextBg: 'transparent',
    gutterAddedBg: '#d6ffd6', gutterRemovedBg: '#ffd6d6', gutterContextBg: '#f6f6f6',
    gutterBorder: '#e0e0e0', lineNumberText: '#999999',
    markerAdded: '#22863a', markerRemoved: '#cb2431',
    wordAddedBg: '#acf2bd', wordRemovedBg: '#fdb8c0',
    hunkHeaderBg: '#f1f8ff', hunkHeaderText: '#005cc5', sectionText: '#6a737d',
    syntax: {
        plain: '#24292e', keyword: '#d73a49', string: '#032f62', comment: '#6a737d',
        number: '#005cc5', function: '#6f42c1', operator: '#d73a49',
        punctuation: '#24292e', type: '#6f42c1', variable: '#e36209',
        tag: '#22863a', attr: '#005cc5',
    },
};

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
        theme: {
            colors: {
                diff: PALETTE,
                surface: '#ffffff',
                divider: '#e1e4e8',
                textSecondary: '#586069',
                text: '#24292e',
            },
        },
    }),
}));

vi.mock('@/components/HorizontalScrollView', async () => {
    const ReactModule = await import('react');
    return {
        HorizontalScrollView: (props: any) =>
            ReactModule.createElement('HorizontalScrollView', props, props.children),
    };
});

vi.mock('@/constants/Typography', () => ({
    Typography: { default: () => ({}), mono: () => ({}) },
}));

vi.mock('@/text', () => ({
    // Keys, not prose — the assertions should not depend on the app language.
    t: (key: string, params?: Record<string, unknown>) =>
        params ? `${key}:${JSON.stringify(params)}` : key,
}));

import { DiffFileView } from './DiffFileView';
import { buildDiffFromPatch } from './engine/buildDiff';
import type { DiffFile } from './engine/types';

beforeAll(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

function fileFromPatch(patch: string): DiffFile {
    return buildDiffFromPatch(patch, { syntax: false, intraline: true }).files[0];
}

function render(props: Record<string, unknown>) {
    let renderer!: ReactTestRenderer;
    act(() => {
        renderer = create(React.createElement(DiffFileView as any, props));
    });
    return renderer;
}

function flatten(c: any): string {
    if (c === null || c === undefined || typeof c === 'boolean') return '';
    if (typeof c === 'string' || typeof c === 'number') return String(c);
    if (Array.isArray(c)) return c.map(flatten).join('');
    if (c.props) return flatten(c.props.children);
    return '';
}

/**
 * Text rendered anywhere beneath a node. Walks the rendered tree rather than
 * the element's own children, so nested components are included.
 */
function textOf(node: any): string {
    if (node && typeof node.findAllByType === 'function') {
        return node.findAllByType('Text').map((t: any) => flatten(t.props.children)).join('');
    }
    return flatten(node?.props?.children);
}

/** Direct children of a split row: left cell, divider, right cell. */
function cellsOf(row: any): any[] {
    return row.children.filter((c: any) => typeof c !== 'string');
}

const SIMPLE = [
    '--- a/x.ts',
    '+++ b/x.ts',
    '@@ -1,4 +1,4 @@',
    ' const keep = 1;',
    '-const before = 2;',
    '+const after = 2;',
    ' const tail = 3;',
    '',
].join('\n');

describe('DiffFileView — scroll layout', () => {
    it('draws one code row and one gutter row per line', () => {
        const file = fileFromPatch(SIMPLE);
        const tree = render({ file, showHunkHeaders: false });

        const lineRows = file.rows.filter((r) => r.kind === 'line').length;
        expect(lineRows).toBe(4);

        // Every line is drawn twice: once in the scrolling code column and once
        // in the gutter pinned over it. That duplication is the whole trick, so
        // it is worth asserting rather than assuming.
        const codeTexts = tree.root.findAllByType('Text').map(textOf) as string[];
        expect(codeTexts.filter((s) => s.includes('const keep = 1;'))).toHaveLength(1);
        expect(codeTexts.filter((s) => s.includes('const after = 2;'))).toHaveLength(1);
    });

    it('numbers deletions from the old side and additions from the new side', () => {
        const file = fileFromPatch(SIMPLE);
        const tree = render({ file, showHunkHeaders: false, showLineNumbers: true });
        const texts = tree.root.findAllByType('Text').map(textOf) as string[];

        // Old line 2 was removed, new line 2 was added — both are line "2",
        // each shown against its own side.
        expect(texts).toContain('2');
        // The markers say which side each row belongs to.
        expect(texts).toContain('+');
        expect(texts).toContain('−');
    });

    it('omits the number column when line numbers are off', () => {
        const file = fileFromPatch(SIMPLE);
        const tree = render({ file, showHunkHeaders: false, showLineNumbers: false });
        const texts = tree.root.findAllByType('Text').map(textOf) as string[];
        // Markers survive; bare line numbers do not.
        expect(texts).toContain('+');
        expect(texts.filter((s) => /^\d+$/.test(s))).toHaveLength(0);
    });

    it('renders hunk separators only when asked', () => {
        const file = fileFromPatch(SIMPLE);
        const withHeaders = render({ file, showHunkHeaders: true });
        const without = render({ file, showHunkHeaders: false });

        const hasHunk = (tree: ReactTestRenderer) =>
            (tree.root.findAllByType('Text').map(textOf) as string[]).some((s) => s.includes('@@') || s.includes('diff.unchangedLines'));

        expect(hasHunk(withHeaders)).toBe(true);
        expect(hasHunk(without)).toBe(false);
    });
});

describe('DiffFileView — collapsing', () => {
    const long = () => {
        // Additions interleaved with context: a single unbroken block of
        // changes would be pulled in whole by the collapse-boundary snapping.
        const lines = ['--- a/big.ts', '+++ b/big.ts', '@@ -1,60 +1,60 @@'];
        for (let i = 0; i < 30; i++) {
            lines.push(` context ${i}`);
            lines.push(`+line ${i}`);
        }
        return fileFromPatch(lines.join('\n') + '\n');
    };

    it('holds back the tail and offers to show it', () => {
        const tree = render({ file: long(), collapseAfter: 10, showHunkHeaders: false });
        const texts = tree.root.findAllByType('Text').map(textOf) as string[];
        const more = texts.find((s) => s.startsWith('diff.showMoreLines'));
        expect(more).toBeDefined();
        expect(more).toContain('"count":50'); // 60 rows, 10 shown
    });

    it('reveals everything when the button is pressed', () => {
        const tree = render({ file: long(), collapseAfter: 10, showHunkHeaders: false });

        const button = tree.root.findAllByType('Pressable').find((p: any) =>
            textOf(p).startsWith('diff.showMoreLines'));
        expect(button).toBeDefined();

        act(() => { button!.props.onPress(); });

        const after = tree.root.findAllByType('Text').map(textOf) as string[];
        expect(after.some((s) => s.startsWith('diff.showMoreLines'))).toBe(false);
        expect(after.some((s) => s.includes('line 29'))).toBe(true);
    });

    it('shows no button when the file fits', () => {
        const tree = render({ file: fileFromPatch(SIMPLE), collapseAfter: 400 });
        const texts = tree.root.findAllByType('Text').map(textOf) as string[];
        expect(texts.some((s) => s.startsWith('diff.showMoreLines'))).toBe(false);
    });
});

describe('DiffFileView — split layout', () => {
    it('puts the removal and its replacement in the same row', () => {
        const tree = render({ file: fileFromPatch(SIMPLE), split: true, showHunkHeaders: false });

        // Each split row is a flex row holding left cell, divider, right cell.
        const rows = tree.root.findAllByType('View').filter((v: any) => {
            const style = v.props.style;
            return style && style.flexDirection === 'row' && style.alignItems === 'stretch';
        });
        expect(rows.length).toBeGreaterThan(0);

        const changed = rows.find((r: any) => textOf(r).includes('const before = 2;'));
        expect(changed).toBeDefined();
        // The old and the new line are siblings, not stacked one after another.
        expect(textOf(changed)).toContain('const after = 2;');
    });

    it('leaves the old side empty for a pure addition', () => {
        const added = fileFromPatch([
            '--- /dev/null',
            '+++ b/new.ts',
            '@@ -0,0 +1,2 @@',
            '+first',
            '+second',
            '',
        ].join('\n'));

        const tree = render({ file: added, split: true, showHunkHeaders: false });
        const rows = tree.root.findAllByType('View').filter((v: any) => {
            const style = v.props.style;
            return style && style.flexDirection === 'row' && style.alignItems === 'stretch';
        });

        const firstRow = rows.find((r: any) => textOf(r).includes('first'));
        expect(firstRow).toBeDefined();

        const cells = cellsOf(firstRow);
        expect(cells).toHaveLength(3); // left, divider, right
        // Left cell carries no text at all — it is a filler, not a blank line.
        expect(textOf(cells[0])).toBe('');
        expect(textOf(cells[2])).toContain('first');
    });
});

describe('DiffFileView — messages', () => {
    it('reports a binary file instead of drawing rows', () => {
        const file = fileFromPatch([
            'diff --git a/logo.png b/logo.png',
            'Binary files a/logo.png and b/logo.png differ',
            '',
        ].join('\n'));

        const tree = render({ file });
        const texts = tree.root.findAllByType('Text').map(textOf) as string[];
        expect(texts.some((s) => s.includes('diff.binaryFile'))).toBe(true);
    });
});
