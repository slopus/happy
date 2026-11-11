import * as React from 'react';
import { act } from 'react';
// @ts-expect-error react-test-renderer has no declarations.
import TestRenderer from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useProjectNavigation } from './useProjectNavigation';
import type { ProjectLocation } from './projectNavigation';

let renderer: any;
afterEach(() => { if (renderer) act(() => renderer.unmount()); });
function setup(initial: ProjectLocation) {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    let navigation!: ReturnType<typeof useProjectNavigation>;
    let location!: ProjectLocation;
    let external!: React.Dispatch<React.SetStateAction<ProjectLocation>>;
    const mounts = vi.fn();
    const writes = vi.fn();
    function MountedFile() { React.useEffect(() => { mounts(); }, []); return null; }
    function Host() {
        [location, external] = React.useState(initial);
        navigation = useProjectNavigation(location, patch => {
            writes(patch);
            // Expo merges params; omitted keys do not clear old state.
            external(previous => ({ ...previous, ...patch }));
        });
        return <MountedFile />;
    }
    act(() => { renderer = TestRenderer.create(<Host />); });
    return { get navigation() { return navigation; }, get location() { return location; },
        external: (value: ProjectLocation) => act(() => external(value)), mounts, writes };
}

describe('mounted project navigation', () => {
    it('opens a conversation explicitly and restores details on Back without remounting the file owner', () => {
        const app = setup({ project: 'p', feature: 'f', task: 't' });
        expect(app.writes).not.toHaveBeenCalled();
        act(() => app.navigation.navigate({ conversation: 'latest' }));
        act(() => app.navigation.back());
        expect(app.location.conversation).toBeUndefined();
        expect(app.location.task).toBe('t');
        expect(app.navigation.canForward).toBe(true);
        act(() => app.navigation.forward());
        expect(app.location.conversation).toBe('latest');
        expect(app.mounts).toHaveBeenCalledTimes(1);
        expect(app.navigation.canForward).toBe(false);
    });
    it('does not retain removed child params when an external link changes the scope', () => {
        const app = setup({ project: 'p', feature: 'f', task: 't', conversation: 'chat' });
        app.external({ project: 'other' });
        act(() => app.navigation.navigate({ feature: 'new' }));
        expect(app.location).toMatchObject({ project: 'other', feature: 'new', task: undefined, conversation: undefined });
        act(() => app.navigation.back());
        expect(app.location.feature).toBeUndefined();
        expect(app.location.conversation).toBeUndefined();
    });
    it('does not replay an abandoned conversation branch after choosing another task', () => {
        const app = setup({ feature: 'f', task: 'one' });
        act(() => app.navigation.navigate({ conversation: 'chat' }));
        act(() => app.navigation.back());
        act(() => app.navigation.navigate({ task: 'two', conversation: undefined }));
        expect(app.navigation.canForward).toBe(false);
        const writes = app.writes.mock.calls.length;
        act(() => app.navigation.forward());
        expect(app.location.task).toBe('two');
        expect(app.location.conversation).toBeUndefined();
        expect(app.writes).toHaveBeenCalledTimes(writes);
    });
});
