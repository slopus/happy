import type { PluginCatalogItem } from '@slopus/happy-wire';
import type { PluginCatalogSnapshot } from '@/sync/pluginCatalogStore';
import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// @ts-expect-error react-test-renderer has no bundled declarations.
import TestRenderer from 'react-test-renderer';

const syncMocks = vi.hoisted(() => {
    const state = {
        snapshot: {
            status: 'idle',
            plugins: [] as readonly PluginCatalogItem[],
            revision: 0,
        } as PluginCatalogSnapshot,
    };
    const listeners = new Set<() => void>();
    return {
        listeners,
        state,
        sync: {
            getPluginCatalogSnapshot: vi.fn(() => state.snapshot),
            refreshPluginCatalog: vi.fn(async () => ({ plugins: state.snapshot.plugins })),
            subscribePluginCatalog: vi.fn((listener: () => void) => {
                listeners.add(listener);
                return () => listeners.delete(listener);
            }),
        },
    };
});

vi.mock('@/sync/sync', () => ({ sync: syncMocks.sync }));

import { usePlugins } from './usePlugins';

function plugin(id: string): PluginCatalogItem {
    return {
        manifest: { id },
        status: { installed: false },
    } as PluginCatalogItem;
}

function Probe({ id }: { id: string }) {
    const value = usePlugins();
    return React.createElement('probe', { id, value });
}

describe('usePlugins', () => {
    const originalConsoleError = console.error;
    let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        vi.clearAllMocks();
        syncMocks.listeners.clear();
        syncMocks.state.snapshot = { status: 'idle', plugins: [], revision: 0 };
        (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
        consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation((...values: unknown[]) => {
            if (values[0] === 'react-test-renderer is deprecated. See https://react.dev/warnings/react-test-renderer') return;
            originalConsoleError(...values);
        });
    });

    afterEach(() => consoleErrorSpy.mockRestore());

    it('shares the central catalog snapshot across plugin consumers', async () => {
        let renderer: any;
        await act(async () => {
            renderer = TestRenderer.create(<>
                <Probe id="first" />
                <Probe id="second" />
            </>);
        });

        expect(syncMocks.sync.refreshPluginCatalog).not.toHaveBeenCalled();
        expect(renderer.root.findAllByType('probe').every((probe: any) => (
            probe.props.value.plugins.length === 0
        ))).toBe(true);
        expect(renderer.root.findAllByType('probe').every((probe: any) => (
            probe.props.value.loading === true
        ))).toBe(true);

        act(() => {
            syncMocks.state.snapshot = {
                status: 'ready',
                plugins: [plugin('server-plugin')],
                revision: 1,
            };
            for (const listener of syncMocks.listeners) listener();
        });

        expect(renderer.root.findAllByType('probe').map((probe: any) => (
            probe.props.value.plugins[0].manifest.id
        ))).toEqual(['server-plugin', 'server-plugin']);
        expect(renderer.root.findAllByType('probe').every((probe: any) => (
            probe.props.value.loading === false
        ))).toBe(true);
        act(() => renderer.unmount());
    });
});
