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

    it('uses Android Back to close the picker before focus mode', () => {
        expect(resolveHomeDockPickerBackAction({ hasPage: true })).toBe('close-picker');
        expect(resolveHomeDockPickerBackAction({ hasPage: false })).toBe('close-focus');
    });

    // Neither way out is silently swallowed: the dock stays up and says so, so
    // the screen never reads as frozen.
    it('refuses both ways out while a session is being created', () => {
        expect(resolveHomeDockPickerBackAction({ hasPage: true, starting: true })).toBe('refuse');
        expect(resolveHomeDockBackdropPressAction({
            nativeMenuOpen: false,
            pickerVisible: false,
            starting: true,
        })).toBe('refuse');
        // Even with a picker open, which would otherwise close first.
        expect(resolveHomeDockBackdropPressAction({
            nativeMenuOpen: false,
            pickerVisible: true,
            starting: true,
        })).toBe('refuse');
        // An open native menu still closes first: it covers the progress.
        expect(resolveHomeDockBackdropPressAction({
            nativeMenuOpen: true,
            pickerVisible: false,
            starting: true,
        })).toBe('dismiss-menu');
    });

    it('does not select disabled picker options', () => {
        expect(isHomeDockOptionSelectable()).toBe(true);
        expect(isHomeDockOptionSelectable(false)).toBe(true);
        expect(isHomeDockOptionSelectable(true)).toBe(false);
    });
});
