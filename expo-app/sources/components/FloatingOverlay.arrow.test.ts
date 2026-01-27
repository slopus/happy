import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function flattenStyle(style: any): Record<string, any> {
    if (!style) return {};
    if (Array.isArray(style)) {
        return style.reduce((acc, item) => ({ ...acc, ...flattenStyle(item) }), {});
    }
    return style;
}

vi.mock('react-native', () => {
    const React = require('react');
    return {
        Platform: { OS: 'web' },
        ScrollView: (props: any) => React.createElement('ScrollView', props, props.children),
    };
});

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
        theme: {
            colors: {
                surface: '#fff',
                modal: { border: 'rgba(0,0,0,0.1)' },
                shadow: { color: 'rgba(0,0,0,0.2)', opacity: 0.2 },
                textSecondary: '#666',
            },
        },
    }),
    StyleSheet: {
        create: (factory: any) => {
            // FloatingOverlay's stylesheet factory is called with (theme, runtime)
            return factory(
                {
                    colors: {
                        surface: '#fff',
                        modal: { border: 'rgba(0,0,0,0.1)' },
                        shadow: { color: 'rgba(0,0,0,0.2)', opacity: 0.2 },
                        textSecondary: '#666',
                    },
                },
                {},
            );
        },
    },
}));

vi.mock('react-native-reanimated', () => {
    const React = require('react');
    const AnimatedView = (props: any) => React.createElement('AnimatedView', props, props.children);
    const AnimatedScrollView = (props: any) => React.createElement('AnimatedScrollView', props, props.children);
    return {
        __esModule: true,
        default: {
            View: AnimatedView,
            ScrollView: AnimatedScrollView,
        },
    };
});

vi.mock('@/components/ui/scroll/ScrollEdgeFades', () => {
    const React = require('react');
    return { ScrollEdgeFades: () => React.createElement('ScrollEdgeFades') };
});

vi.mock('@/components/ui/scroll/ScrollEdgeIndicators', () => {
    const React = require('react');
    return { ScrollEdgeIndicators: () => React.createElement('ScrollEdgeIndicators') };
});

vi.mock('@/components/ui/scroll/useScrollEdgeFades', () => ({
    useScrollEdgeFades: () => ({
        visibility: { top: false, bottom: false, left: false, right: false },
        onViewportLayout: () => {},
        onContentSizeChange: () => {},
        onScroll: () => {},
    }),
}));

describe('FloatingOverlay', () => {
    it('renders an arrow when configured', async () => {
        const { FloatingOverlay } = await import('./FloatingOverlay');

        let tree: ReturnType<typeof renderer.create> | undefined;
        act(() => {
            tree = renderer.create(
                React.createElement(
                    FloatingOverlay,
                    {
                        maxHeight: 200,
                        arrow: { placement: 'bottom' },
                    } as any,
                    React.createElement('Child'),
                ),
            );
        });

        const arrows = tree?.root.findAllByProps({ testID: 'floating-overlay-arrow' } as any) ?? [];
        // Our Animated shim is a wrapper component returning a host element; filter to host nodes.
        const hostArrows = arrows.filter((node: any) => typeof node.type === 'string');
        expect(hostArrows.length).toBe(1);
    });

    it('renders edge indicators when enabled without edge fades', async () => {
        const { FloatingOverlay } = await import('./FloatingOverlay');

        let tree: ReturnType<typeof renderer.create> | undefined;
        act(() => {
            tree = renderer.create(
                React.createElement(
                    FloatingOverlay,
                    {
                        maxHeight: 200,
                        edgeIndicators: true,
                        edgeFades: false,
                    } as any,
                    React.createElement('Child'),
                ),
            );
        });

        const indicators = tree?.root.findAll((node) => (node as any).type === 'ScrollEdgeIndicators') ?? [];
        expect(indicators.length).toBe(1);
    });
});
