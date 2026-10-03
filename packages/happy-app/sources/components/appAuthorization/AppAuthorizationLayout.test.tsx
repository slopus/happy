import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthorizationChoice, AuthorizationSection } from './AppAuthorizationLayout';

// react-test-renderer does not provide TypeScript declarations in this workspace.
// @ts-expect-error Only the renderer's minimal create/update/unmount interface is used.
import TestRenderer from 'react-test-renderer';

vi.mock('react-native', () => ({
    Platform: { OS: 'web' },
    Pressable: 'Pressable',
    Text: 'Text',
    View: 'View',
}));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
vi.mock('@/components/ItemList', () => ({ ItemList: 'ItemList' }));
vi.mock('@/components/layout', () => ({ layout: { maxWidth: 800 } }));
vi.mock('@/constants/Typography', () => ({ Typography: { default: () => ({}) } }));
vi.mock('react-native-unistyles', () => {
    const theme = { colors: {} };
    return {
        StyleSheet: { create: (factory: (value: typeof theme) => object) => factory(theme) },
        useUnistyles: () => ({ theme }),
    };
});

describe('authorization choice keyboard interaction', () => {
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

    it('Space selects once without scrolling and does not activate a disabled choice', () => {
        const onPress = vi.fn();
        const preventDefault = vi.fn();
        act(() => {
            renderer = TestRenderer.create(<AuthorizationChoice title="Machine" selected={false} onPress={onPress} />);
        });
        const press = (repeat = false) => renderer.root.findByType('Pressable').props.onKeyDown({ key: ' ', repeat, preventDefault });
        expect(renderer.root.findByType('Pressable').props['aria-checked']).toBe(false);

        act(() => press());
        expect(onPress).toHaveBeenCalledTimes(1);
        expect(preventDefault).toHaveBeenCalledTimes(1);
        act(() => press(true));
        expect(onPress).toHaveBeenCalledTimes(1);

        act(() => {
            renderer.update(<AuthorizationChoice title="Machine" selected disabled onPress={onPress} />);
        });
        expect(renderer.root.findByType('Pressable').props['aria-checked']).toBe(true);
        act(() => press());
        expect(onPress).toHaveBeenCalledTimes(1);
    });

    it('arrow and boundary keys move focus and select the same available option', () => {
        act(() => {
            renderer = TestRenderer.create(<AuthorizationSection title="Devices" radio><></></AuthorizationSection>);
        });
        const group = renderer.root.findAllByType('View').find((node: any) => node.props.accessibilityRole === 'radiogroup');
        const options = Array.from({ length: 3 }, () => ({ focus: vi.fn(), click: vi.fn() }));
        const querySelectorAll = vi.fn(() => options);
        const preventDefault = vi.fn();
        for (const [key, current, expected] of [
            ['ArrowRight', 0, 1], ['ArrowLeft', 0, 2], ['Home', 2, 0], ['End', 0, 2],
        ] as const) {
            options.forEach(option => { option.focus.mockClear(); option.click.mockClear(); });
            act(() => group.props.onKeyDown({ key, target: options[current], currentTarget: { querySelectorAll }, preventDefault }));
            expect(options[expected].focus).toHaveBeenCalledOnce();
            expect(options[expected].click).toHaveBeenCalledOnce();
            expect(options.filter(option => option.focus.mock.calls.length > 0)).toHaveLength(1);
        }
        expect(querySelectorAll).toHaveBeenCalledWith('[role="radio"]:not([aria-disabled="true"])');
        expect(preventDefault).toHaveBeenCalledTimes(4);
    });
});
