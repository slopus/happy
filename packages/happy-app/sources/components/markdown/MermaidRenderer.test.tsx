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
}));

vi.mock('react-native', () => ({
    Modal: 'Modal',
    Platform: { OS: 'web' },
    Pressable: 'Pressable',
    Text: 'Text',
    View: 'View',
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
        },
    };
    return {
        StyleSheet: {
            absoluteFillObject: { bottom: 0, left: 0, position: 'absolute', right: 0, top: 0 },
            create: (factory: any) => factory(theme, { insets: { bottom: 0, left: 0, right: 0, top: 0 } }),
        },
        useUnistyles: () => ({ theme }),
    };
});
vi.mock('@/constants/Typography', () => ({ Typography: { default: () => ({}), mono: () => ({}) } }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('mermaid', () => ({
    default: {
        initialize: vi.fn(),
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

describe('MermaidRenderer', () => {
    const originalConsoleError = console.error;
    let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
    let renderer: TestRenderer.ReactTestRenderer | undefined;

    beforeEach(() => {
        vi.clearAllMocks();
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
                createNodeMock: (element: { type: string }) => element.type === 'div'
                    ? { querySelector: () => ({}) }
                    : {},
            });
        });

        expect(renderer!.root.findByType('Modal').props.visible).toBe(false);
        act(() => renderer!.root.findByProps({ testID: 'mermaid-fullscreen-open' }).props.onPress());
        expect(renderer!.root.findByType('Modal').props.visible).toBe(true);
        expect(renderer!.root.findByProps({ testID: 'mermaid-fullscreen-surface' })).toBeDefined();

        act(() => renderer!.root.findByProps({ testID: 'mermaid-fullscreen-close' }).props.onPress());
        expect(renderer!.root.findByType('Modal').props.visible).toBe(false);
    });

    it('renders the inline zoom controls with accessible labels', async () => {
        await act(async () => {
            renderer = TestRenderer.create(<MermaidRenderer content="flowchart LR\nA --> B" />, {
                createNodeMock: (element: { type: string }) => element.type === 'div'
                    ? { querySelector: () => ({}) }
                    : {},
            });
        });

        expect(renderer!.root.findByProps({ testID: 'mermaid-zoom-in' }).props.accessibilityLabel)
            .toBe('keyboardShortcuts.zoomIn');
        expect(renderer!.root.findByProps({ testID: 'mermaid-zoom-out' }).props.accessibilityLabel)
            .toBe('keyboardShortcuts.zoomOut');
        expect(renderer!.root.findByProps({ testID: 'mermaid-zoom-reset' }).props.accessibilityLabel)
            .toBe('keyboardShortcuts.resetZoom');
    });

    it('uses the themed pressed surface while a toolbar button is hovered', async () => {
        await act(async () => {
            renderer = TestRenderer.create(<MermaidRenderer content="flowchart LR\nA --> B" />, {
                createNodeMock: (element: { type: string }) => element.type === 'div'
                    ? { querySelector: () => null }
                    : {},
            });
        });

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
                minScale: 0.5,
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
