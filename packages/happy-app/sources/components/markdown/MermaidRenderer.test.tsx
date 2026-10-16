import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error react-test-renderer is only used by this component harness.
import TestRenderer from 'react-test-renderer';

const mocks = vi.hoisted(() => ({
    destroy: vi.fn(),
    panzoom: vi.fn(),
    reset: vi.fn(),
    zoomIn: vi.fn(),
    zoomOut: vi.fn(),
    zoomWithWheel: vi.fn(),
    windowWidth: 1440,
}));

vi.mock('react-native', () => ({
    Modal: 'Modal',
    Platform: { OS: 'web' },
    Pressable: 'Pressable',
    Text: 'Text',
    View: 'View',
    useWindowDimensions: () => ({ width: mocks.windowWidth, height: 720 }),
}));
vi.mock('react-native-webview', () => ({ WebView: 'WebView' }));
vi.mock('@expo/vector-icons', () => ({ Feather: 'Feather' }));
vi.mock('react-native-unistyles', () => {
    const theme = {
        dark: true,
        colors: {
            divider: '#39424c',
            surface: '#12171c',
            surfaceHigh: '#1b2229',
            surfaceHighest: '#242c34',
            surfacePressed: '#303a45',
            text: '#f4f7fa',
            textSecondary: '#aeb8c2',
            modal: { backdrop: 'rgba(0,0,0,0.62)' },
        },
    };
    return {
        StyleSheet: {
            absoluteFillObject: { bottom: 0, left: 0, position: 'absolute', right: 0, top: 0 },
            create: (factory: any) => factory(theme, { insets: { bottom: 0, left: 0, right: 0, top: 0 }, screen: { height: 720 } }),
        },
        useUnistyles: () => ({ theme }),
    };
});
vi.mock('@/constants/Typography', () => ({ Typography: { default: () => ({}), mono: () => ({}) } }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('@/modal', () => ({ Modal: { alert: vi.fn() } }));
vi.mock('@/utils/imageDownload', () => ({ downloadImage: vi.fn().mockResolvedValue('paws-diagram.svg') }));
vi.mock('./mermaidSvgImage', () => ({
    createMermaidImageUri: (svg: string) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`,
}));
vi.mock('mermaid', () => ({
    default: {
        initialize: vi.fn(),
        registerLayoutLoaders: vi.fn(),
        render: vi.fn().mockResolvedValue({ svg: '<svg viewBox="0 0 200 100"><g /></svg>' }),
    },
}));
vi.mock('@panzoom/panzoom', () => ({
    default: mocks.panzoom.mockImplementation(() => ({
        destroy: mocks.destroy,
        reset: mocks.reset,
        zoomIn: mocks.zoomIn,
        zoomOut: mocks.zoomOut,
        zoomWithWheel: mocks.zoomWithWheel,
    })),
}));

import { initializeWebDiagramPanzoom, MermaidRenderer } from './MermaidRenderer';
import { downloadImage } from '@/utils/imageDownload';

function createNodeMock(element: { type: string }) {
    if (element.type !== 'div') return {};
    return {
        style: {}, clientWidth: 200, clientHeight: 100,
        addEventListener: vi.fn(), removeEventListener: vi.fn(),
        parentElement: { clientWidth: 1000, clientHeight: 600, addEventListener: vi.fn(), removeEventListener: vi.fn() },
        querySelector: () => ({ style: {}, setAttribute: vi.fn(), viewBox: { baseVal: { width: 200, height: 100 } } }),
    };
}

describe('MermaidRenderer', () => {
    const originalConsoleError = console.error;
    let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
    let renderer: TestRenderer.ReactTestRenderer | undefined;

    beforeEach(() => {
        vi.clearAllMocks();
        mocks.windowWidth = 1440;
        (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
        consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation((...values: unknown[]) => {
            if (values[0] === 'react-test-renderer is deprecated. See https://react.dev/warnings/react-test-renderer') return;
            originalConsoleError(...values);
        });
    });

    afterEach(() => {
        act(() => renderer?.unmount());
        renderer = undefined;
        consoleErrorSpy.mockRestore();
    });

    it('opens and closes a full-screen diagram surface', async () => {
        await act(async () => {
            renderer = TestRenderer.create(<MermaidRenderer content="flowchart LR\nA --> B" />, {
                createNodeMock,
            });
        });

        expect(renderer!.root.findByType('Modal').props.visible).toBe(false);
        await act(async () => renderer!.root.findByProps({ testID: 'mermaid-fullscreen-open' }).props.onPress());
        expect(renderer!.root.findByType('Modal').props.visible).toBe(true);
        expect(renderer!.root.findByProps({ testID: 'mermaid-fullscreen-surface' })).toBeDefined();
        expect(renderer!.root.findByProps({ testID: 'mermaid-download' }).props.accessibilityLabel).toBe('imageViewer.download');
        expect(renderer!.root.findByProps({ testID: 'mermaid-zoom-percent' })).toBeDefined();

        act(() => renderer!.root.findByProps({ testID: 'mermaid-fullscreen-close' }).props.onPress());
        expect(renderer!.root.findByType('Modal').props.visible).toBe(false);
    });

    it('keeps desktop preview text at natural size and fits the frame to the diagram', async () => {
        await act(async () => {
            renderer = TestRenderer.create(<MermaidRenderer content="flowchart LR\nA --> B" />, {
                createNodeMock,
            });
        });

        await act(async () => { await vi.dynamicImportSettled(); });
        const image = renderer!.root.findByType('img');
        expect(decodeURIComponent(image.props.src)).toContain('<svg viewBox="0 0 200 100">');
        expect(image.props.style.height).toBe('auto');
        expect(image.props.style.width).toBe('auto');
        expect(image.props.style.flexShrink).toBe(0);
        act(() => image.props.onLoad({ currentTarget: { naturalWidth: 200 } }));
        const trigger = renderer!.root.findByProps({ testID: 'mermaid-fullscreen-open' });
        expect(Object.assign({}, ...trigger.props.style)).toMatchObject({ width: 234, maxWidth: '100%', alignSelf: 'flex-start' });
        expect(image.props.draggable).toBe(false);
        expect(renderer!.root.findByProps({ testID: 'mermaid-fullscreen-open' }).props.accessibilityRole).toBe('button');
        expect(renderer!.root.findAllByProps({ testID: 'mermaid-zoom-in' })).toHaveLength(0);
        expect(mocks.panzoom).not.toHaveBeenCalled();
        const canvas = image.parent!;
        expect(Object.assign({}, ...canvas.props.style)).toMatchObject({ maxHeight: 432, minHeight: 0, overflow: 'hidden' });
        expect(Object.assign({}, ...canvas.props.style).height).toBeUndefined();

        await act(async () => renderer!.root.findByProps({ testID: 'mermaid-fullscreen-open' }).props.onPress());
        await act(async () => { await vi.dynamicImportSettled(); });
        await act(async () => { await vi.dynamicImportSettled(); });
        expect(mocks.panzoom).toHaveBeenCalledOnce();
        expect(renderer!.root.findByProps({ testID: 'mermaid-zoom-percent' }).props.children).toBe('100%');
        await act(async () => renderer!.root.findByProps({ testID: 'mermaid-download' }).props.onPress());
        expect(downloadImage).toHaveBeenCalledWith({
            filename: 'paws-diagram.svg',
            uri: expect.stringContaining('data:image/svg+xml;'),
        });
        expect(renderer!.root.findByProps({ testID: 'mermaid-zoom-in' }).props.accessibilityLabel)
            .toBe('keyboardShortcuts.zoomIn');
        expect(renderer!.root.findByProps({ testID: 'mermaid-zoom-out' }).props.accessibilityLabel)
            .toBe('keyboardShortcuts.zoomOut');
        expect(renderer!.root.findByProps({ testID: 'mermaid-zoom-reset' }).props.accessibilityLabel)
            .toBe('keyboardShortcuts.resetZoom');
    });

    it('preserves the approved width-fit mobile preview when resizing from desktop', async () => {
        await act(async () => {
            renderer = TestRenderer.create(<MermaidRenderer content="flowchart TD\nA --> B" />, { createNodeMock });
        });
        await act(async () => { await vi.dynamicImportSettled(); });
        const image = renderer!.root.findByType('img');
        act(() => image.props.onLoad({ currentTarget: { naturalWidth: 200 } }));
        mocks.windowWidth = 390;
        await act(async () => renderer!.update(<MermaidRenderer content="flowchart TD\nA --> B" typography="chatMono" />));
        expect(renderer!.root.findByType('img').props.style.width).toBe('100%');
        expect(Object.assign({}, ...renderer!.root.findByType('img').parent!.props.style).maxHeight).toBe(504);
        expect(Object.assign({}, ...renderer!.root.findByProps({ testID: 'mermaid-fullscreen-open' }).props.style).width).toBe('100%');
    });

    it('uses the themed pressed surface while a toolbar button is hovered', async () => {
        await act(async () => {
            renderer = TestRenderer.create(<MermaidRenderer content="flowchart LR\nA --> B" />, {
                createNodeMock: (element: { type: string }) => element.type === 'div'
                    ? { querySelector: () => null }
                    : {},
            });
        });

        await act(async () => renderer!.root.findByProps({ testID: 'mermaid-fullscreen-open' }).props.onPress());
        const button = renderer!.root.findAllByType('Pressable')
            .find((node: { props: { testID?: string } }) => node.props.testID === 'mermaid-zoom-in')!;
        act(() => button.props.onHoverIn());

        expect(button.props.style({ pressed: false })).toContainEqual({ backgroundColor: '#303a45' });
    });

    it('allows default-scale mouse panning without stealing ordinary page scroll', () => {
        let wheelHandler: ((event: WheelEvent) => void) | undefined;
        const viewport = {
            addEventListener: vi.fn((type: string, handler: (event: WheelEvent) => void) => {
                if (type === 'wheel') wheelHandler = handler;
            }),
            removeEventListener: vi.fn(),
        };
        const scene = {
            parentElement: viewport,
            addEventListener: vi.fn(), removeEventListener: vi.fn(),
        };
        const createPanzoom = vi.fn(() => ({
            destroy: mocks.destroy,
            zoomWithWheel: mocks.zoomWithWheel,
        }));

        const controller = initializeWebDiagramPanzoom(
            scene as unknown as HTMLElement,
            createPanzoom as unknown as Parameters<typeof initializeWebDiagramPanzoom>[1],
        );

        expect(createPanzoom).toHaveBeenCalledWith(
            scene,
            {
                canvas: true,
                maxScale: 5,
                minScale: 0.1,
                startScale: 1,
                step: 0.25,
            },
        );
        expect(wheelHandler).toBeDefined();

        const ordinaryWheel = { ctrlKey: false, metaKey: false } as WheelEvent;
        wheelHandler!(ordinaryWheel);
        expect(mocks.zoomWithWheel).not.toHaveBeenCalled();

        const modifiedWheel = { ctrlKey: true, metaKey: false } as WheelEvent;
        wheelHandler!(modifiedWheel);
        expect(mocks.zoomWithWheel).toHaveBeenCalledWith(modifiedWheel);

        controller.dispose();
        expect(viewport.removeEventListener).toHaveBeenCalledWith('wheel', wheelHandler);
        expect(mocks.destroy).toHaveBeenCalledOnce();
    });
});
