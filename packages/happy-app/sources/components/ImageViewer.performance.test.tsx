import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// @ts-expect-error react-test-renderer does not publish declarations here.
import TestRenderer from 'react-test-renderer';

import { ImageViewer } from './ImageViewer';

vi.mock('react-native', async () => {
    const ReactModule = await import('react');
    const ScrollView = ReactModule.forwardRef((props: any, _ref) => (
        ReactModule.createElement('ScrollView', props, props.children)
    ));
    return {
        NativeScrollEvent: {},
        NativeSyntheticEvent: {},
        Platform: { OS: 'web' },
        Pressable: 'Pressable',
        ScrollView,
        StyleSheet: {
            absoluteFillObject: {},
            create: (styles: object) => styles,
            hairlineWidth: 1,
        },
        Text: 'Text',
        View: 'View',
        useWindowDimensions: () => ({ width: 1280, height: 800 }),
    };
});
vi.mock('expo-image', () => ({ Image: 'Image' }));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));
vi.mock('react-native-reanimated', () => ({
    default: { View: 'AnimatedView' },
    Extrapolation: { CLAMP: 'clamp' },
    interpolate: () => 1,
    runOnJS: (fn: (...args: any[]) => unknown) => fn,
    useAnimatedStyle: (factory: () => object) => factory(),
    useSharedValue: (value: number) => ({ value }),
    withTiming: (value: number) => value,
}));
vi.mock('react-native-gesture-handler', () => {
    const gesture = () => {
        const chain: Record<string, any> = {};
        for (const method of ['activeOffsetY', 'enabled', 'failOffsetX', 'numberOfTaps', 'onEnd', 'onUpdate']) {
            chain[method] = () => chain;
        }
        return chain;
    };
    return {
        Gesture: {
            Exclusive: gesture,
            Pan: gesture,
            Pinch: gesture,
            Simultaneous: gesture,
            Tap: gesture,
        },
        GestureDetector: ({ children }: { children: React.ReactNode }) => children,
    };
});
vi.mock('@/utils/imageDownload', () => ({ downloadImage: vi.fn() }));
vi.mock('@/hooks/useAttachmentImage', () => ({
    useAttachmentImage: () => ({ uri: null, loading: false, error: null }),
}));
vi.mock('@/sync/resolveMotionPhotoAttachmentSource', () => ({
    resolveMotionPhotoAttachmentSource: vi.fn(),
}));
vi.mock('@/components/tools/views/MediaAttachmentPlayer', () => ({
    MediaAttachmentPlayer: 'MediaAttachmentPlayer',
}));
vi.mock('@/components/DesktopShortcutTooltip', () => ({
    DesktopShortcutTooltip: 'DesktopShortcutTooltip',
}));
vi.mock('@/modal', () => ({ Modal: { alert: vi.fn() } }));
vi.mock('@/text', () => ({ t: (key: string) => key }));

describe('ImageViewer large gallery performance', () => {
    let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
        consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
        consoleErrorSpy.mockRestore();
    });

    it('mounts only the focused image and its neighbours for a large gallery', () => {
        const sources = Array.from({ length: 100 }, (_, index) => ({
            uri: `blob:image-${index}`,
            width: 3840,
            height: 2560,
        }));
        let renderer: any;

        act(() => {
            renderer = TestRenderer.create(
                <ImageViewer sources={sources} initialIndex={50} onClose={() => {}} />,
            );
        });

        const mountedUris = renderer.root
            .findAllByType('Image')
            .map((node: any) => node.props.source.uri);

        expect(mountedUris).toContain('blob:image-50');
        expect(mountedUris.length).toBeLessThanOrEqual(3);

        act(() => renderer.unmount());
    });
});
