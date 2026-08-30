import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// @ts-expect-error react-test-renderer has no bundled declarations.
import TestRenderer from 'react-test-renderer';

const mocks = vi.hoisted(() => ({
    item: null as any,
    refresh: vi.fn(),
}));

vi.mock('./usePlugins', () => ({
    usePlugins: () => ({
        getPlugin: () => mocks.item,
        loading: false,
        refresh: mocks.refresh,
    }),
}));

import { useGeneratedImagesPlugin } from './useGeneratedImagesPlugin';

function Probe() {
    const value = useGeneratedImagesPlugin();
    return React.createElement('probe', { value });
}

function galleryItem(permissions: string[]) {
    return {
        manifest: {
            schemaVersion: 2,
            hostApiVersion: 1,
            id: 'generated-images-gallery',
            version: '1.1.1',
            title: { default: 'Gallery' },
            description: { default: 'Gallery' },
            icon: 'albums-outline',
            featured: true,
            installedAction: 'open',
            permissions,
            entrypoint: { type: 'view', viewId: 'generated-images-gallery.browser' },
            contributes: {
                views: [{
                    id: 'generated-images-gallery.browser',
                    surface: 'page',
                    title: { default: 'Gallery' },
                }],
            },
            configuration: { fields: [] },
        },
        status: {
            installed: true,
            version: '1.1.1',
            grantedPermissions: [...permissions],
            configuration: {},
            secretHints: {},
        },
    };
}

describe('useGeneratedImagesPlugin', () => {
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

    it('requires the trusted entrypoint capability before enabling a deep-linked page', () => {
        mocks.item = galleryItem([]);
        let renderer: any;
        act(() => {
            renderer = TestRenderer.create(<Probe />);
        });
        expect(renderer.root.findByType('probe').props.value.status).toEqual({ installed: false });

        mocks.item = galleryItem(['paws.conversations.images.read']);
        act(() => renderer.update(<Probe />));
        expect(renderer.root.findByType('probe').props.value.status).toEqual({ installed: true });
        act(() => renderer.unmount());
    });
});
