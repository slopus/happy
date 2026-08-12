import { describe, expect, it, vi } from 'vitest';

import { createShortcutSections, type ShortcutCatalogContext } from './shortcutCatalog';

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

const baseContext: ShortcutCatalogContext = {
    commandPaletteEnabled: true,
    enterToSend: true,
    inTauri: false,
    platform: 'MacIntel',
    rightPanelAvailable: true,
};

function getRows(context: ShortcutCatalogContext) {
    return createShortcutSections(context).flatMap((section) => section.rows);
}

function getRow(context: ShortcutCatalogContext, id: string) {
    return getRows(context).find((row) => row.id === id);
}

describe('createShortcutSections', () => {
    it('formats macOS shortcuts with symbol keycaps', () => {
        expect(getRow(baseContext, 'open-command-palette')?.alternatives).toEqual([['⌘', 'P']]);
        expect(getRow(baseContext, 'toggle-right-panel')?.alternatives).toEqual([['⌥', '⌘', 'B']]);
        expect(getRow(baseContext, 'open-keyboard-shortcuts')?.alternatives).toEqual([['⌘', '/']]);
        expect(getRow(baseContext, 'send-message')?.alternatives).toEqual([['↵']]);
        expect(getRow(baseContext, 'insert-new-line')?.alternatives).toEqual([['⇧', '↵']]);
        expect(getRow(baseContext, 'run-selected')?.alternatives).toEqual([['↵']]);
    });

    it('formats Windows and Linux shortcuts with text keycaps', () => {
        const context = { ...baseContext, platform: 'Win32' };

        expect(getRow(context, 'open-command-palette')?.alternatives).toEqual([['Ctrl', 'P']]);
        expect(getRow(context, 'toggle-right-panel')?.alternatives).toEqual([['Alt', 'Ctrl', 'B']]);
        expect(getRow(context, 'open-keyboard-shortcuts')?.alternatives).toEqual([['Ctrl', '/']]);
        expect(getRow(context, 'send-message')?.alternatives).toEqual([['Enter']]);
        expect(getRow(context, 'insert-new-line')?.alternatives).toEqual([['Shift', 'Enter']]);
    });

    it('only includes desktop zoom shortcuts in Tauri', () => {
        expect(createShortcutSections(baseContext).map((section) => section.id)).not.toContain('desktop-app');

        const desktopSection = createShortcutSections({ ...baseContext, inTauri: true })
            .find((section) => section.id === 'desktop-app');

        expect(desktopSection?.rows.map((row) => row.id)).toEqual(['zoom-in', 'zoom-out', 'reset-zoom']);
    });

    it('omits the right-panel shortcut when that capability is unavailable', () => {
        expect(getRow({ ...baseContext, rightPanelAvailable: false }, 'toggle-right-panel')).toBeUndefined();
    });

    it('keeps a disabled command-palette shortcut discoverable with localized guidance', () => {
        const row = getRow({ ...baseContext, commandPaletteEnabled: false }, 'open-command-palette');

        expect(row?.alternatives).toEqual([['⌘', 'P']]);
        expect(row?.detail).toBe('keyboardShortcuts.commandPaletteDisabled');
    });

    it('matches send and newline rows to the Enter-to-Send preference', () => {
        const enabledContext = { ...baseContext, platform: 'Win32', enterToSend: true };
        expect(getRow(enabledContext, 'send-message')?.alternatives).toEqual([['Enter']]);
        expect(getRow(enabledContext, 'insert-new-line')?.alternatives).toEqual([['Shift', 'Enter']]);

        const disabledContext = { ...enabledContext, enterToSend: false };
        expect(getRow(disabledContext, 'send-message')).toBeUndefined();
        expect(getRow(disabledContext, 'insert-new-line')?.alternatives).toEqual([['Enter']]);
    });

    it('does not advertise unsupported new-session or Command+Enter shortcuts', () => {
        const ids = getRows({ ...baseContext, inTauri: true }).map((row) => row.id);

        expect(ids).not.toContain('new-session');
        expect(ids).not.toContain('command-enter-send');
    });
});
