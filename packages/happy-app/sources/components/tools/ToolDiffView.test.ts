import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

const settings = vi.hoisted(() => ({ numbers: false, read: vi.fn() }));
vi.mock('@/sync/storage', () => ({ useSetting: (key: string) => {
    settings.read(key);
    return key === 'showLineNumbersInToolViews' ? settings.numbers : true;
} }));
vi.mock('react-native', async () => {
    const React = await import('react');
    return { View: (props: any) => React.createElement('View', props, props.children) };
});
vi.mock('@/components/diff/DiffChunk', async () => {
    const React = await import('react');
    return { DiffChunk: (props: any) => React.createElement('DiffChunk', props) };
});
import { ToolDiffView } from './ToolDiffView';

let tree: ReturnType<typeof create>;
afterEach(() => {
    act(() => tree?.unmount());
    vi.unstubAllGlobals();
    settings.read.mockClear();
});

describe('inline diff presentation', () => {
    it.each([false, true])('uses View Changes scrolling while respecting the line-number preference (%s)', (numbers) => {
        vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
        settings.numbers = numbers;
        act(() => { tree = create(React.createElement(ToolDiffView, { oldText: 'old', newText: 'new', fileName: 'a.ts' })); });
        expect(tree.root.findByType('DiffChunk').props).toMatchObject({
            wrap: false, showLineNumbers: numbers, fileName: 'a.ts', oldText: 'old', newText: 'new',
        });
        expect(settings.read).not.toHaveBeenCalledWith('wrapLinesInDiffs');
    });

    it('allows the full-screen viewer to explicitly show numbers', () => {
        vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
        settings.numbers = false;
        act(() => { tree = create(React.createElement(ToolDiffView, { patch: 'patch', showLineNumbers: true })); });
        expect(tree.root.findByType('DiffChunk').props.showLineNumbers).toBe(true);
    });
});