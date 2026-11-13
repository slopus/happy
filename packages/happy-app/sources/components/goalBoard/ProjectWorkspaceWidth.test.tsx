import * as React from 'react';
import { act } from 'react';
// @ts-expect-error react-test-renderer has no declarations.
import TestRenderer from 'react-test-renderer';
import { afterEach, expect, it } from 'vitest';
import { ProjectWorkspaceWidthProvider, useProjectWorkspaceWidth } from './ProjectWorkspaceWidth';

let renderer: any;
afterEach(() => { if (renderer) act(() => renderer.unmount()); });

it('keeps the measured width on the first render of another Task and the global scope', () => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    const renders: Array<{ scope: string; width: number }> = [];
    let measure!: (width: number) => void;
    function Workspace({ scope }: { scope: string }) {
        const layout = useProjectWorkspaceWidth();
        measure = layout.measure;
        renders.push({ scope, width: layout.width });
        return null;
    }
    const tree = (scope: string) => <ProjectWorkspaceWidthProvider><Workspace key={scope} scope={scope} /></ProjectWorkspaceWidthProvider>;
    act(() => { renderer = TestRenderer.create(tree('task-a')); });
    act(() => measure(1600));
    act(() => renderer.update(tree('task-b')));
    act(() => renderer.update(tree('global')));
    expect(renders.filter(row => row.scope === 'task-b')).toEqual([{ scope: 'task-b', width: 1600 }]);
    expect(renders.filter(row => row.scope === 'global')).toEqual([{ scope: 'global', width: 1600 }]);
    act(() => measure(1200));
    expect(renders.at(-1)).toEqual({ scope: 'global', width: 1200 });
});

it('does not share measurements across project owners', () => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    let layout!: ReturnType<typeof useProjectWorkspaceWidth>;
    function Workspace() { layout = useProjectWorkspaceWidth(); return null; }
    const tree = (owner: string) => <ProjectWorkspaceWidthProvider key={owner}><Workspace /></ProjectWorkspaceWidthProvider>;
    act(() => { renderer = TestRenderer.create(tree('account-a')); });
    act(() => layout.measure(1600));
    act(() => renderer.update(tree('account-b')));
    expect(layout.width).toBe(0);
});
