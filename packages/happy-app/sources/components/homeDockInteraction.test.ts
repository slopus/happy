import { describe, expect, it } from 'vitest';

import {
    isHomeDockOptionSelectable,
    resolveCustomProjectPathSelection,
    resolveHomeDockBackdropPressAction,
    resolveHomeDockMachineSelection,
    resolveHomeDockPickerBackAction,
    resolveHomeDockPromptPlaceholder,
    shouldUseNativeHomeDockMenus,
} from './homeDockInteraction';

describe('HomeDock interaction lifecycle', () => {
    it('ignores a custom-project prompt result after HomeDock unmounts', () => {
        expect(resolveCustomProjectPathSelection('~/project', false)).toBeNull();
    });

    it('trims a mounted custom-project prompt result', () => {
        expect(resolveCustomProjectPathSelection('  ~/project  ', true)).toBe('~/project');
        expect(resolveCustomProjectPathSelection('   ', true)).toBeNull();
    });

    it('routes only Android through the React Native picker', () => {
        expect(shouldUseNativeHomeDockMenus('android')).toBe(false);
        expect(shouldUseNativeHomeDockMenus('ios')).toBe(true);
        expect(shouldUseNativeHomeDockMenus('web')).toBe(true);
    });

    it('reconciles a missing machine ID with the machine HomeDock displays', () => {
        expect(resolveHomeDockMachineSelection(null, ['online', 'offline'])).toBe('online');
        expect(resolveHomeDockMachineSelection('removed', ['online', 'offline'])).toBe('online');
        expect(resolveHomeDockMachineSelection('offline', ['online', 'offline'])).toBe('offline');
        expect(resolveHomeDockMachineSelection('loading', [])).toBe('loading');
    });

    it('names the selected legacy agent in the focused prompt', () => {
        expect(resolveHomeDockPromptPlaceholder('codex', 'Codex')).toBe('Ask Codex');
        expect(resolveHomeDockPromptPlaceholder('claude', 'Claude Code')).toBe('Ask Claude Code');
    });

    it('dismisses an open native menu before closing the focused dock', () => {
        expect(resolveHomeDockBackdropPressAction({
            nativeMenuOpen: true,
            pickerVisible: false,
        })).toBe('dismiss-menu');
        expect(resolveHomeDockBackdropPressAction({
            nativeMenuOpen: false,
            pickerVisible: true,
        })).toBe('close-picker');
        expect(resolveHomeDockBackdropPressAction({
            nativeMenuOpen: false,
            pickerVisible: false,
        })).toBe('close-focus');
    });

    it('uses Android Back to unwind the picker before focus mode', () => {
        expect(resolveHomeDockPickerBackAction({ hasPage: true, rootVisible: true })).toBe('show-root');
        expect(resolveHomeDockPickerBackAction({ hasPage: true, rootVisible: false })).toBe('close-picker');
        expect(resolveHomeDockPickerBackAction({ hasPage: false, rootVisible: true })).toBe('close-picker');
        expect(resolveHomeDockPickerBackAction({ hasPage: false, rootVisible: false })).toBe('close-focus');
    });

    it('does not select disabled picker options', () => {
        expect(isHomeDockOptionSelectable()).toBe(true);
        expect(isHomeDockOptionSelectable(false)).toBe(true);
        expect(isHomeDockOptionSelectable(true)).toBe(false);
    });
});
