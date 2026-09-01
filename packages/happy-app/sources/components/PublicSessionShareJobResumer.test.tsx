import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// @ts-expect-error react-test-renderer has no declarations in this workspace.
import TestRenderer from 'react-test-renderer';

const mocks = vi.hoisted(() => ({
    resume: vi.fn(async () => undefined),
    onChange: null as ((state: string) => void) | null,
    remove: vi.fn(),
}));

vi.mock('react-native', () => ({
    AppState: {
        addEventListener: (_event: string, listener: (state: string) => void) => {
            mocks.onChange = listener;
            return { remove: mocks.remove };
        },
    },
}));
vi.mock('@/sync/publicSessionShareQueueRuntime', () => ({
    resumePublicSessionShareJobs: mocks.resume,
}));

import { PublicSessionShareJobResumer } from './PublicSessionShareJobResumer';

describe('PublicSessionShareJobResumer', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.onChange = null;
        (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    });

    afterEach(() => {
        delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
    });

    it('resumes persisted work on mount and whenever the app becomes active', async () => {
        let renderer: any;
        await act(async () => {
            renderer = TestRenderer.create(<PublicSessionShareJobResumer />);
        });
        expect(mocks.resume).toHaveBeenCalledOnce();

        act(() => mocks.onChange?.('background'));
        expect(mocks.resume).toHaveBeenCalledOnce();
        act(() => mocks.onChange?.('active'));
        expect(mocks.resume).toHaveBeenCalledTimes(2);

        act(() => renderer.unmount());
        expect(mocks.remove).toHaveBeenCalledOnce();
    });
});
