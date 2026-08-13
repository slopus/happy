import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// @ts-expect-error react-test-renderer does not publish declarations here.
import TestRenderer from 'react-test-renderer';

import { ImageViewer } from './ImageViewer';

const mocks = vi.hoisted(() => ({
    release: vi.fn(),
    resolveMotionSource: vi.fn(async () => ({
        uri: 'file:///cache/photo.jpg.mp4',
        headers: {},
        release: mocks.release,
    })),
}));

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
        useWindowDimensions: () => ({ width: 390, height: 844 }),
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
    resolveMotionPhotoAttachmentSource: mocks.resolveMotionSource,
}));
vi.mock('@/components/tools/views/MediaAttachmentPlayer', () => ({
    MediaAttachmentPlayer: 'MediaAttachmentPlayer',
}));
vi.mock('@/components/DesktopShortcutTooltip', () => ({
    DesktopShortcutTooltip: 'DesktopShortcutTooltip',
}));
vi.mock('@/modal', () => ({ Modal: { alert: vi.fn() } }));
vi.mock('@/text', () => ({ t: (key: string) => key }));

const motionSource = {
    uri: 'data:image/jpeg;base64,AA==',
    filename: 'photo.jpg',
    width: 1080,
    height: 1920,
    sessionId: 's1',
    attachmentRef: 'sessions/s1/attachments/photo.enc',
    motionPhoto: { videoOffset: 2000, videoLength: 1000, mimeType: 'video/mp4' as const },
};

describe('ImageViewer motion photos', () => {
    let consoleWarnSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
        mocks.release.mockClear();
        mocks.resolveMotionSource.mockReset();
        mocks.resolveMotionSource.mockResolvedValue({
            uri: 'file:///cache/photo.jpg.mp4',
            headers: {},
            release: mocks.release,
        });
        consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => consoleWarnSpy.mockRestore());

    it('shows the still image first and starts motion only from the viewer button', async () => {
        let renderer: any;
        await act(async () => {
            renderer = TestRenderer.create(
                <ImageViewer sources={[motionSource]} initialIndex={0} onClose={() => {}} />,
            );
        });

        expect(renderer.root.findByType('Image').props.source.uri).toBe(motionSource.uri);
        expect(renderer.root.findAllByProps({ testID: 'motion-photo-viewer-player' })).toHaveLength(0);
        const toggle = renderer.root.findByProps({ testID: 'motion-photo-viewer-toggle' });
        expect(toggle.props.accessibilityLabel).toBe('imageViewer.playMotionPhoto');

        await act(async () => { toggle.props.onPress(); });

        expect(mocks.resolveMotionSource).toHaveBeenCalledWith({
            sessionId: 's1',
            ref: 'sessions/s1/attachments/photo.enc',
            fileName: 'photo.jpg',
        });
        expect(renderer.root.findByProps({ testID: 'motion-photo-viewer-player' }).props).toMatchObject({
            uri: 'file:///cache/photo.jpg.mp4',
            kind: 'video',
            aspectRatio: 1080 / 1920,
        });

        await act(async () => {
            renderer.root.findByProps({ testID: 'motion-photo-viewer-toggle' }).props.onPress();
        });
        expect(renderer.root.findAllByProps({ testID: 'motion-photo-viewer-player' })).toHaveLength(0);
        expect(mocks.release).toHaveBeenCalledTimes(1);
        act(() => renderer.unmount());
    });

    it('does not show a motion toggle for an ordinary image', () => {
        let renderer: any;
        act(() => {
            renderer = TestRenderer.create(
                <ImageViewer sources={[{ uri: 'data:image/jpeg;base64,AA==' }]} initialIndex={0} onClose={() => {}} />,
            );
        });
        expect(renderer.root.findAllByProps({ testID: 'motion-photo-viewer-toggle' })).toHaveLength(0);
        act(() => renderer.unmount());
    });

    it('shows the state-aware motion tooltip on hover and keyboard focus', async () => {
        let renderer: any;
        await act(async () => {
            renderer = TestRenderer.create(
                <ImageViewer sources={[motionSource]} initialIndex={0} onClose={() => {}} />,
            );
        });
        let toggle = renderer.root.findByProps({ testID: 'motion-photo-viewer-toggle' });
        expect(renderer.root.findByProps({ testID: 'motion-photo-viewer-tooltip' }).props.visible).toBe(false);
        act(() => toggle.props.onHoverIn());
        expect(renderer.root.findByProps({ testID: 'motion-photo-viewer-tooltip' }).props).toMatchObject({
            label: 'imageViewer.playMotionPhoto',
            visible: true,
        });
        act(() => toggle.props.onFocus());
        act(() => toggle.props.onHoverOut());
        expect(renderer.root.findByProps({ testID: 'motion-photo-viewer-tooltip' }).props.visible).toBe(true);
        act(() => toggle.props.onBlur());
        expect(renderer.root.findByProps({ testID: 'motion-photo-viewer-tooltip' }).props.visible).toBe(false);

        await act(async () => { toggle.props.onPress(); });
        toggle = renderer.root.findByProps({ testID: 'motion-photo-viewer-toggle' });
        act(() => toggle.props.onFocus());
        expect(renderer.root.findByProps({ testID: 'motion-photo-viewer-tooltip' }).props).toMatchObject({
            label: 'imageViewer.stopMotionPhoto',
            visible: true,
        });
        act(() => renderer.unmount());
    });

    it('releases a late motion source after paging away without mounting its player', async () => {
        let resolveLateSource!: (source: {
            uri: string;
            headers: Record<string, string>;
            release: typeof mocks.release;
        }) => void;
        mocks.resolveMotionSource.mockReturnValueOnce(new Promise((resolve) => {
            resolveLateSource = resolve;
        }));
        let renderer: any;
        await act(async () => {
            renderer = TestRenderer.create(
                <ImageViewer
                    sources={[motionSource, { uri: 'data:image/jpeg;base64,BB==', filename: 'still.jpg' }]}
                    initialIndex={0}
                    onClose={() => {}}
                />,
            );
        });

        act(() => renderer.root.findByProps({ testID: 'motion-photo-viewer-toggle' }).props.onPress());
        act(() => renderer.root.findByType('ScrollView').props.onScroll({
            nativeEvent: { contentOffset: { x: 390, y: 0 } },
        }));
        expect(renderer.root.findAllByProps({ testID: 'motion-photo-viewer-toggle' })).toHaveLength(0);

        await act(async () => {
            resolveLateSource({
                uri: 'file:///cache/late-photo.mp4',
                headers: {},
                release: mocks.release,
            });
        });

        expect(mocks.release).toHaveBeenCalledTimes(1);
        expect(renderer.root.findAllByProps({ testID: 'motion-photo-viewer-player' })).toHaveLength(0);
        act(() => renderer.unmount());
        expect(mocks.release).toHaveBeenCalledTimes(1);
    });
});
