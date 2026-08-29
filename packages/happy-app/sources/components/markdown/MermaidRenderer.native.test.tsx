import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error react-test-renderer is only used by this component harness.
import TestRenderer from 'react-test-renderer';

vi.mock('react-native', () => ({
    Modal: 'Modal',
    Platform: { OS: 'android' },
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
    const runtime = { insets: { bottom: 12, left: 0, right: 0, top: 24 } };
    return {
        StyleSheet: {
            absoluteFillObject: { bottom: 0, left: 0, position: 'absolute', right: 0, top: 0 },
            create: (factory: any) => factory(theme, runtime),
            hairlineWidth: 1,
        },
        useUnistyles: () => ({ theme }),
    };
});
vi.mock('@/constants/Typography', () => ({ Typography: { default: () => ({}), mono: () => ({}) } }));
vi.mock('@/text', () => ({ t: (key: string) => key }));

import { MermaidRenderer } from './MermaidRenderer';

describe('MermaidRenderer native interaction contract', () => {
    let renderer: TestRenderer.ReactTestRenderer | undefined;

    beforeEach(() => {
        (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    });

    afterEach(() => {
        act(() => renderer?.unmount());
        renderer = undefined;
    });

    it('keeps diagram pan gestures inside an Android chat scroll view', async () => {
        await act(async () => {
            renderer = TestRenderer.create(<MermaidRenderer content="flowchart LR\nA --> B" />);
        });

        expect(renderer!.root.findByType('WebView').props).toMatchObject({
            nestedScrollEnabled: true,
            overScrollMode: 'never',
            scrollEnabled: true,
        });
    });

    it('uses an edge-to-edge safe-area-aware fullscreen surface', async () => {
        await act(async () => {
            renderer = TestRenderer.create(<MermaidRenderer content="flowchart LR\nA --> B" />);
        });

        act(() => renderer!.root.findByProps({ testID: 'mermaid-fullscreen-open' }).props.onPress());

        const modal = renderer!.root.findByType('Modal');
        const surface = renderer!.root.findByProps({ testID: 'mermaid-fullscreen-surface' });
        expect(modal.props).toMatchObject({
            navigationBarTranslucent: true,
            statusBarTranslucent: true,
        });
        expect(surface.props.style).toContainEqual({
            borderRadius: 0,
            borderWidth: 0,
            flex: 1,
            width: '100%',
        });
        expect(renderer!.root.findByProps({ testID: 'mermaid-fullscreen-backdrop' }).props.style).toMatchObject({
            paddingBottom: 12,
            paddingTop: 24,
        });
    });
});
