import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// react-test-renderer does not publish TypeScript declarations with the package.
// @ts-expect-error The test only uses the create/unmount surface below.
import TestRenderer from 'react-test-renderer';

const mocks = vi.hoisted(() => ({
    hasUnread: true as boolean,
    markAsRead: vi.fn(),
    push: vi.fn(),
    reloadApp: vi.fn(),
    updateAvailable: false as boolean,
    updateUrl: null as string | null,
}));

vi.mock('react-native', () => ({ Platform: { OS: 'web' } }));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
        theme: {
            colors: {
                success: '#0a0',
                text: '#111',
            },
        },
    }),
}));
vi.mock('@/components/Item', () => ({ Item: 'Item' }));
vi.mock('@/components/ItemGroup', () => ({ ItemGroup: 'ItemGroup' }));
vi.mock('@/hooks/useUpdates', () => ({
    useUpdates: () => ({
        reloadApp: mocks.reloadApp,
        updateAvailable: mocks.updateAvailable,
    }),
}));
vi.mock('@/hooks/useChangelog', () => ({
    useChangelog: () => ({
        hasUnread: mocks.hasUnread,
        markAsRead: mocks.markAsRead,
    }),
}));
vi.mock('@/hooks/useNativeUpdate', () => ({ useNativeUpdate: () => mocks.updateUrl }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock('@/utils/openExternalUrl', () => ({ openExternalUrl: vi.fn() }));
vi.mock('@/text', () => ({ t: (key: string) => key }));

import { UpdateBanner } from './UpdateBanner';

describe('UpdateBanner', () => {
    const originalConsoleError = console.error;
    let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
    let renderer: any;

    beforeEach(() => {
        vi.clearAllMocks();
        mocks.hasUnread = true;
        mocks.updateAvailable = false;
        mocks.updateUrl = null;
        (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
        consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation((...values: unknown[]) => {
            if (values[0] === 'react-test-renderer is deprecated. See https://react.dev/warnings/react-test-renderer') return;
            originalConsoleError(...values);
        });
    });

    afterEach(() => {
        if (renderer) {
            act(() => renderer.unmount());
        }
        renderer = undefined;
        consoleErrorSpy.mockRestore();
    });

    it('does not render a card for unread changelog entries', () => {
        act(() => {
            renderer = TestRenderer.create(<UpdateBanner />);
        });

        expect(renderer.toJSON()).toBeNull();
    });

    it('keeps rendering an available OTA update', () => {
        mocks.updateAvailable = true;

        act(() => {
            renderer = TestRenderer.create(<UpdateBanner />);
        });

        expect(renderer.root.findByType('Item').props.title).toBe('updateBanner.updateAvailable');
    });

    it('keeps rendering an available native update', () => {
        mocks.updateUrl = 'https://example.com/update';

        act(() => {
            renderer = TestRenderer.create(<UpdateBanner />);
        });

        expect(renderer.root.findByType('Item').props.title).toBe('updateBanner.nativeUpdateAvailable');
    });
});
