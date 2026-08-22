import { describe, expect, it } from 'vitest';

import {
    isHomeDockOptionSelectable,
    resolveCustomProjectPathSelection,
    resolveHomeDockPickerBackAction,
    shouldShowHomeDockEnvironmentPicker,
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

    it('keeps worktree interaction out of the Android picker repair', () => {
        expect(shouldShowHomeDockEnvironmentPicker('worktree', 'android')).toBe(false);
        expect(shouldShowHomeDockEnvironmentPicker('project', 'android')).toBe(true);
        expect(shouldShowHomeDockEnvironmentPicker('worktree', 'ios')).toBe(true);
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
