import * as React from 'react';
import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// @ts-expect-error react-test-renderer does not publish declarations used by this narrow test.
import TestRenderer from 'react-test-renderer';

const mocks = vi.hoisted(() => ({
    images: vi.fn(() => []),
    replace: vi.fn(),
    status: { installed: false } as { installed: boolean },
}));

vi.mock('react-native', () => ({
    ActivityIndicator: 'ActivityIndicator',
    FlatList: 'FlatList',
    Text: 'Text',
    View: 'View',
    useWindowDimensions: () => ({ width: 1280, height: 800 }),
}));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
vi.mock('expo-router', () => ({ useRouter: () => ({ replace: mocks.replace }) }));
vi.mock('react-native-unistyles', () => ({
    StyleSheet: { create: (factory: unknown) => typeof factory === 'function' ? (factory as () => object)() : factory },
    useUnistyles: () => ({ theme: { colors: { accent: '#00f', groupped: { background: '#fff' }, text: '#111', textSecondary: '#666' } } }),
}));
vi.mock('@/components/layout', () => ({ layout: { maxWidth: 1200 } }));
vi.mock('@/components/GeneratedImageCard', () => ({ GeneratedImageCard: 'GeneratedImageCard' }));
vi.mock('@/hooks/useGeneratedImages', () => ({ useGeneratedImages: mocks.images }));
vi.mock('@/hooks/useGeneratedImagesPlugin', () => ({
    useGeneratedImagesPlugin: () => ({ loading: false, status: mocks.status }),
}));
vi.mock('@/text', () => ({ t: (key: string) => key }));

import GeneratedImagesScreen from './generated-images';

describe('GeneratedImagesScreen plugin guard', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.status = { installed: false };
    });

    it('redirects and does not load gallery data before the plugin is installed', () => {
        let renderer: any;
        act(() => {
            renderer = TestRenderer.create(<GeneratedImagesScreen />);
        });

        expect(mocks.replace).toHaveBeenCalledWith('/');
        expect(mocks.images).not.toHaveBeenCalled();
        expect(renderer.root.findByProps({ testID: 'generated-images-plugin-guard' })).toBeTruthy();
        act(() => renderer.unmount());
    });

    it('loads the gallery after installation', () => {
        mocks.status = { installed: true };
        let renderer: any;
        act(() => {
            renderer = TestRenderer.create(<GeneratedImagesScreen />);
        });

        expect(mocks.replace).not.toHaveBeenCalled();
        expect(mocks.images).toHaveBeenCalledTimes(1);
        act(() => renderer.unmount());
    });
});
