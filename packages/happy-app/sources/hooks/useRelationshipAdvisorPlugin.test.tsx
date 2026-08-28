import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// @ts-expect-error react-test-renderer has no bundled declarations.
import TestRenderer from 'react-test-renderer';

const mocks = vi.hoisted(() => ({
    enabled: false,
    item: null as any,
    refresh: vi.fn(),
}));

vi.mock('./usePlugins', () => ({
    usePlugins: (enabled: boolean) => {
        mocks.enabled = enabled;
        return {
            getPlugin: () => mocks.item,
            loading: false,
            refresh: mocks.refresh,
        };
    },
}));

import { useRelationshipAdvisorPlugin } from './useRelationshipAdvisorPlugin';

function Probe({ enabled = true }: { enabled?: boolean }) {
    const value = useRelationshipAdvisorPlugin(enabled);
    return React.createElement('probe', { value });
}

describe('useRelationshipAdvisorPlugin', () => {
    const originalConsoleError = console.error;
    let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        vi.clearAllMocks();
        mocks.item = null;
        (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
        consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation((...values: unknown[]) => {
            if (values[0] === 'react-test-renderer is deprecated. See https://react.dev/warnings/react-test-renderer') return;
            originalConsoleError(...values);
        });
    });

    afterEach(() => consoleErrorSpy.mockRestore());

    it('loads server installation status only while the consuming surface is active', async () => {
        let renderer: any;
        await act(async () => {
            renderer = TestRenderer.create(<Probe enabled={false} />);
        });
        expect(mocks.enabled).toBe(false);

        mocks.item = {
            manifest: {
                id: 'relationship-advisor',
                version: '1.1.1',
                permissions: ['paws.ai.provider.invoke', 'paws.secrets.use'],
                entrypoint: { type: 'view', viewId: 'relationship-advisor.chat' },
                contributes: {
                    views: [{ id: 'relationship-advisor.chat', surface: 'page' }],
                },
            },
            status: { installed: false },
        };
        await act(async () => {
            renderer.update(<Probe enabled />);
        });

        expect(mocks.enabled).toBe(true);
        expect(renderer.root.findByType('probe').props.value).toEqual({
            loading: false,
            status: { installed: false },
            refresh: expect.any(Function),
        });
        act(() => renderer.unmount());
    });
});
