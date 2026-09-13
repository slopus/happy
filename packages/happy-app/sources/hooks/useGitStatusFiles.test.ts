import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ getStatus: vi.fn(), applyStatus: vi.fn() }));
vi.mock('@/sync/gitStatusFiles', () => ({ getGitStatusFiles: mocks.getStatus }));
vi.mock('@/sync/storage', () => ({
    useSessionGitStatusFiles: () => null,
    storage: { getState: () => ({ getSessionPathKey: () => 'machine:/repo', applyGitStatusFiles: mocks.applyStatus }) },
}));
vi.mock('expo-router', async () => {
    const ReactModule = await import('react');
    return { useFocusEffect: (effect: React.EffectCallback) => ReactModule.useEffect(effect, [effect]) };
});
import { useGitStatusFiles } from './useGitStatusFiles';

let renderer: ReturnType<typeof create> | undefined;
function Harness({ enabled }: { enabled: boolean }) {
    useGitStatusFiles('session', enabled);
    return null;
}
afterEach(async () => {
    await act(async () => renderer?.unmount());
    renderer = undefined;
    mocks.getStatus.mockReset();
    mocks.applyStatus.mockReset();
    vi.unstubAllGlobals();
});

describe('legacy Git status lifecycle', () => {
    it('does not run the shell-backed status path for a native Changes view', async () => {
        vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
        mocks.getStatus.mockResolvedValue(null);
        await act(async () => { renderer = create(React.createElement(Harness, { enabled: false })); });
        await act(async () => renderer.update(React.createElement(Harness, { enabled: false })));
        expect(mocks.getStatus).not.toHaveBeenCalled();
        expect(mocks.applyStatus).not.toHaveBeenCalled();
        await act(async () => renderer.update(React.createElement(Harness, { enabled: true })));
        expect(mocks.getStatus).toHaveBeenCalledExactlyOnceWith('session');
        expect(mocks.applyStatus).toHaveBeenCalledExactlyOnceWith('machine:/repo', null);
        await act(async () => renderer.update(React.createElement(Harness, { enabled: true })));
        expect(mocks.getStatus).toHaveBeenCalledTimes(1);
    });
});