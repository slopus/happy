import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error react-test-renderer is only used for this focused component test.
import TestRenderer from 'react-test-renderer';

vi.mock('react-native', () => ({
    Platform: { OS: 'web' },
    StyleSheet: { create: (styles: object) => styles },
    TextInput: 'TextInput',
    View: 'View',
}));
vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
        theme: {
            colors: {
                surfaceHigh: '#eee',
                text: '#111',
                textSecondary: '#666',
            },
        },
    }),
}));
vi.mock('@/constants/Typography', () => ({ Typography: { default: () => ({}) } }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('@/utils/colorOpacity', () => ({ multiplyColorOpacity: () => '#ddd' }));

import { CommandPaletteInput } from './CommandPaletteInput';

describe('CommandPaletteInput keyboard handling', () => {
    const onKeyPress = vi.fn();
    let renderer: any;

    beforeEach(() => {
        vi.clearAllMocks();
        vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
        act(() => {
            renderer = TestRenderer.create(
                <CommandPaletteInput
                    value=""
                    onChangeText={() => {}}
                    onKeyPress={onKeyPress}
                    activeDescendantId="command-palette-option-session-alpha"
                />,
            );
        });
    });

    afterEach(() => {
        act(() => renderer.unmount());
        vi.unstubAllGlobals();
    });

    function press(key: string, altKey = false, code = `Digit${key}`) {
        const preventDefault = vi.fn();
        const stopPropagation = vi.fn();
        act(() => renderer.root.findByType('TextInput').props.onKeyPress({
            nativeEvent: { altKey, code, key },
            preventDefault,
            stopPropagation,
        }));
        return { preventDefault, stopPropagation };
    }

    it('lets bare digits reach the input and reserves Alt/Option+1..9 for quick selection', () => {
        const bareDigit = press('1');
        expect(bareDigit.preventDefault).not.toHaveBeenCalled();
        expect(onKeyPress).not.toHaveBeenCalled();

        const modifiedDigit = press('¡', true, 'Digit1');
        expect(modifiedDigit.preventDefault).toHaveBeenCalledOnce();
        expect(modifiedDigit.stopPropagation).toHaveBeenCalledOnce();
        expect(onKeyPress).toHaveBeenCalledWith('Alt+1');
    });

    it('exposes the active option while DOM focus remains in the combobox', () => {
        const input = renderer.root.findByType('TextInput');
        expect(input.props.role).toBe('combobox');
        expect(input.props['aria-expanded']).toBe(true);
        expect(input.props['aria-controls']).toBe('command-palette-results');
        expect(input.props['aria-activedescendant']).toBe('command-palette-option-session-alpha');
    });
});
