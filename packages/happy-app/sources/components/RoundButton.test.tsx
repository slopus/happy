import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RoundButton } from './RoundButton';

// react-test-renderer does not provide TypeScript declarations in this workspace.
// @ts-expect-error Only the renderer's minimal create/unmount interface is used.
import TestRenderer from 'react-test-renderer';

vi.mock('react-native', () => ({
    ActivityIndicator: 'ActivityIndicator',
    Platform: { OS: 'web' },
    Pressable: 'Pressable',
    Text: 'Text',
    View: 'View',
}));
vi.mock('react-native-typography', () => ({ iOSUIKit: { title3: {} } }));
vi.mock('@/constants/Typography', () => ({ Typography: { default: () => ({}) } }));
vi.mock('react-native-unistyles', () => {
    const theme = {
        colors: {
            button: { primary: { background: '#1657d9', tint: '#ffffff' } },
            text: '#151515',
        },
    };
    return {
        StyleSheet: {
            create: (factory: (value: typeof theme) => object) => factory(theme),
        },
        useUnistyles: () => ({ theme }),
    };
});

function flattenStyle(style: unknown): Record<string, unknown> {
    if (Array.isArray(style)) return Object.assign({}, ...style.map(flattenStyle));
    return style && typeof style === 'object' ? style as Record<string, unknown> : {};
}

describe('RoundButton disabled and loading feedback', () => {
    let renderer: any;
    let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
        consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
        if (renderer) act(() => renderer.unmount());
        renderer = undefined;
        consoleErrorSpy.mockRestore();
    });

    it.each([false, true])('keeps the disabled opacity when pressed is %s', (pressed) => {
        act(() => {
            renderer = TestRenderer.create(<RoundButton title="Allow connection" disabled />);
        });

        const button = renderer.root.findByType('Pressable');
        expect(flattenStyle(button.props.style({ pressed })).opacity).toBe(0.45);
        expect(button.props.disabled).toBe(true);
        expect(button.props.accessibilityState).toEqual({ disabled: true, busy: false });
    });

    it('distinguishes an enabled button from a disabled button', () => {
        act(() => {
            renderer = TestRenderer.create(<RoundButton title="Allow connection" />);
        });

        const button = renderer.root.findByType('Pressable');
        expect(flattenStyle(button.props.style({ pressed: false })).opacity).toBe(1);
        expect(button.props.disabled).toBeFalsy();
        expect(button.props.accessibilityRole).toBe('button');
        expect(button.props.accessibilityLabel).toBe('Allow connection');
        expect(button.props.accessibilityState).toEqual({ disabled: false, busy: false });
        expect(button.props['aria-busy']).toBe(false);
    });

    it('announces a pending action and displays a spinner while blocking input', () => {
        act(() => {
            renderer = TestRenderer.create(<RoundButton title="Connecting" loading disabled />);
        });

        const button = renderer.root.findByType('Pressable');
        expect(button.props.disabled).toBe(true);
        expect(button.props.accessibilityState).toEqual({ disabled: true, busy: true });
        expect(button.props['aria-busy']).toBe(true);
        expect(button.props.accessibilityLabel).toBe('Connecting');
        expect(renderer.root.findAllByType('ActivityIndicator')).toHaveLength(1);
    });
});
