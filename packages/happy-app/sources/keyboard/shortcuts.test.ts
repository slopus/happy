import { describe, expect, it } from 'vitest';
import {
    formatShortcut,
    formatShortcutChord,
    getGlobalShortcutId,
    getPreferredShortcutModifier,
    getPressedShortcutModifier,
    getRecentSessionShortcutIndex,
    matchesShortcutChord,
    SESSION_ACTION_SHORTCUTS,
    SIDEBAR_PICKER_SHORTCUTS,
} from './shortcuts';

function keyboardEvent(overrides: Partial<Parameters<typeof getGlobalShortcutId>[0]> = {}) {
    return {
        key: 'k',
        metaKey: true,
        ctrlKey: false,
        altKey: false,
        shiftKey: false,
        ...overrides,
    };
}

describe('getGlobalShortcutId', () => {
    it.each([
        ['k', 'commandPalette'],
        ['K', 'commandPalette'],
        ['n', 'newSession'],
        [',', 'settings'],
    ] as const)('maps %s to %s', (key, expected) => {
        expect(getGlobalShortcutId(keyboardEvent({ key }))).toBe(expected);
    });

    it('supports Control on non-Mac keyboards', () => {
        expect(getGlobalShortcutId(keyboardEvent({ metaKey: false, ctrlKey: true, key: 'n' }))).toBe('newSession');
    });

    it('requires Alt for browser-safe global shortcuts', () => {
        expect(getGlobalShortcutId(keyboardEvent({ key: 'n', altKey: true }), true)).toBe('newSession');
        expect(getGlobalShortcutId(keyboardEvent({ key: '˜', code: 'KeyN', altKey: true }), true)).toBe('newSession');
        expect(getGlobalShortcutId(keyboardEvent({ key: 'n' }), true)).toBeNull();
        expect(getGlobalShortcutId(keyboardEvent({ key: 'n', altKey: true }))).toBeNull();
        expect(getGlobalShortcutId(keyboardEvent({
            key: 'n',
            altKey: true,
            getModifierState: (key) => key === 'AltGraph',
        }), true)).toBeNull();
    });

    it.each([
        { metaKey: false },
        { altKey: true },
        { shiftKey: true },
        { isComposing: true },
        { key: 'x' },
    ])('ignores modified or unrelated events: %o', (overrides) => {
        expect(getGlobalShortcutId(keyboardEvent(overrides))).toBeNull();
    });
});

describe('shortcut modifier helpers', () => {
    it('detects modifier-only key presses', () => {
        expect(getPressedShortcutModifier({ key: 'Meta', altKey: false })).toBe('meta');
        expect(getPressedShortcutModifier({ key: 'Control', altKey: false })).toBe('control');
        expect(getPressedShortcutModifier({ key: 'Meta', altKey: true })).toBeNull();
        expect(getPressedShortcutModifier({ key: 'k', altKey: false })).toBeNull();
    });

    it('prefers Command for Apple platforms and Control elsewhere', () => {
        expect(getPreferredShortcutModifier({ platform: 'MacIntel' })).toBe('meta');
        expect(getPreferredShortcutModifier({ userAgentData: { platform: 'macOS' } })).toBe('meta');
        expect(getPreferredShortcutModifier({ platform: 'Win32' })).toBe('control');
        expect(getPreferredShortcutModifier({ platform: 'Linux x86_64' })).toBe('control');
    });

    it('formats platform-appropriate labels', () => {
        expect(formatShortcut('meta', 'K')).toBe('⌘K');
        expect(formatShortcut('control', 'K')).toBe('Ctrl+K');
        expect(formatShortcut('meta', 'K', true)).toBe('⌥⌘K');
        expect(formatShortcut('control', 'K', true)).toBe('Ctrl+Alt+K');
    });
});

describe('recent session shortcuts', () => {
    it.each([
        ['1', 0],
        ['5', 4],
        ['9', 8],
    ] as const)('maps %s to recent session index %s', (key, expected) => {
        expect(getRecentSessionShortcutIndex(keyboardEvent({ key }))).toBe(expected);
    });

    it('requires Alt for browser-safe recent session shortcuts', () => {
        expect(getRecentSessionShortcutIndex(keyboardEvent({ key: '3', altKey: true }), true)).toBe(2);
        expect(getRecentSessionShortcutIndex(keyboardEvent({ key: '£', code: 'Digit3', altKey: true }), true)).toBe(2);
        expect(getRecentSessionShortcutIndex(keyboardEvent({ key: '3' }), true)).toBeNull();
    });

    it.each([
        { key: '0' },
        { key: '1', metaKey: false },
        { key: '1', altKey: true },
        { key: '1', shiftKey: true },
        { key: '1', isComposing: true },
    ])('ignores unavailable or modified digit events: %o', (overrides) => {
        expect(getRecentSessionShortcutIndex(keyboardEvent(overrides))).toBeNull();
    });

});

describe('session action shortcuts', () => {
    it('defines a shortcut for every session action', () => {
        expect(Object.keys(SESSION_ACTION_SHORTCUTS)).toEqual([
            'details',
            'resume',
            'fork',
            'duplicate',
            'copy-metadata',
            'copy-metadata-and-logs',
            'archive',
        ]);
    });

    it('formats Mac and non-Mac shortcut chords', () => {
        expect(formatShortcutChord('meta', SESSION_ACTION_SHORTCUTS.details)).toBe('⌥⌘O');
        expect(formatShortcutChord('meta', SESSION_ACTION_SHORTCUTS['copy-metadata-and-logs'])).toBe('⌥⇧⌘M');
        expect(formatShortcutChord('meta', SESSION_ACTION_SHORTCUTS.archive)).toBe('⇧⌘A');
        expect(formatShortcutChord('control', SESSION_ACTION_SHORTCUTS.details)).toBe('Ctrl+Alt+O');
        expect(formatShortcutChord('control', SESSION_ACTION_SHORTCUTS.archive)).toBe('Ctrl+Shift+A');
    });

    it('matches only the exact chord for the current platform', () => {
        const details = SESSION_ACTION_SHORTCUTS.details;
        expect(matchesShortcutChord(keyboardEvent({ key: 'o', altKey: true }), 'meta', details)).toBe(true);
        expect(matchesShortcutChord(keyboardEvent({ key: 'o' }), 'meta', details)).toBe(false);
        expect(matchesShortcutChord(keyboardEvent({ key: 'o', altKey: true, shiftKey: true }), 'meta', details)).toBe(false);
        expect(matchesShortcutChord(keyboardEvent({ key: 'o', altKey: true, metaKey: false, ctrlKey: true }), 'control', details)).toBe(true);
        expect(matchesShortcutChord(keyboardEvent({ key: 'o', altKey: true, repeat: true }), 'meta', details)).toBe(false);
        expect(matchesShortcutChord(keyboardEvent({ key: 'ø', code: 'KeyO', altKey: true }), 'meta', details)).toBe(true);
    });
});

describe('sidebar picker shortcuts', () => {
    it('defines mnemonic shortcuts for every picker action', () => {
        expect(Object.keys(SIDEBAR_PICKER_SHORTCUTS)).toEqual([
            'changes',
            'allFiles',
            'newSideChat',
        ]);
        expect(formatShortcutChord('meta', SIDEBAR_PICKER_SHORTCUTS.changes)).toBe('⌥⌘C');
        expect(formatShortcutChord('meta', SIDEBAR_PICKER_SHORTCUTS.allFiles)).toBe('⌥⌘F');
        expect(formatShortcutChord('meta', SIDEBAR_PICKER_SHORTCUTS.newSideChat)).toBe('⌥⌘S');
    });
});
