import type { Ionicons } from '@expo/vector-icons';

import { t } from '@/text';
import { getDesktopPanelShortcutPresentation } from '@/utils/desktopNavigationLayout';

export type ShortcutCatalogContext = {
    enterToSend: boolean;
    inTauri: boolean;
    platform: string;
    rightPanelAvailable: boolean;
};

export type ShortcutRow = {
    id: string;
    icon: keyof typeof Ionicons.glyphMap;
    label: string;
    detail?: string;
    alternatives: readonly (readonly string[])[];
};

export type ShortcutSection = {
    id: 'common' | 'navigation' | 'command-palette' | 'conversation' | 'desktop-app';
    title: string;
    rows: readonly ShortcutRow[];
};

function usesMacModifiers(platform: string): boolean {
    return /Mac|iPhone|iPad|iPod/i.test(platform);
}

function formatKeyToken(token: string, isMac: boolean): string {
    switch (token) {
        case 'Meta':
        case 'Control':
            return isMac ? '⌘' : 'Ctrl';
        case 'Alt':
            return isMac ? '⌥' : 'Alt';
        case 'Shift':
            return isMac ? '⇧' : 'Shift';
        case 'Enter':
            return isMac ? '↵' : 'Enter';
        case 'ArrowUp':
            return '↑';
        case 'ArrowDown':
            return '↓';
        default:
            return token;
    }
}

function formatChord(tokens: readonly string[], isMac: boolean): readonly string[] {
    return tokens.map((token) => formatKeyToken(token, isMac));
}

function formatAriaChord(chord: string, isMac: boolean): readonly string[] {
    return formatChord(chord.split('+'), isMac);
}

export function createShortcutSections(context: ShortcutCatalogContext): ShortcutSection[] {
    const isMac = usesMacModifiers(context.platform);
    const panels = getDesktopPanelShortcutPresentation(context.platform);
    const chord = (...tokens: string[]) => formatChord(tokens, isMac);

    const commonRows: ShortcutRow[] = [
        {
            id: 'open-command-palette',
            icon: 'terminal-outline',
            label: t('keyboardShortcuts.openCommandPalette'),
            alternatives: [chord('Meta', 'P')],
        },
        {
            id: 'open-settings',
            icon: 'settings-outline',
            label: t('keyboardShortcuts.openSettings'),
            alternatives: [chord('Meta', ',')],
        },
        {
            id: 'open-keyboard-shortcuts',
            icon: 'help-circle-outline',
            label: t('keyboardShortcuts.open'),
            alternatives: [chord('Meta', '/')],
        },
        {
            id: 'toggle-left-sidebar',
            icon: 'albums-outline',
            label: t('keyboardShortcuts.toggleLeftSidebar'),
            alternatives: [formatAriaChord(panels.leftAria, isMac)],
        },
    ];

    if (context.rightPanelAvailable) {
        commonRows.push({
            id: 'toggle-right-panel',
            icon: 'reader-outline',
            label: t('keyboardShortcuts.toggleRightPanel'),
            alternatives: [formatAriaChord(panels.rightAria, isMac)],
        });
    }

    const conversationRows: ShortcutRow[] = [];
    if (context.enterToSend) {
        conversationRows.push({
            id: 'send-message',
            icon: 'send-outline',
            label: t('keyboardShortcuts.sendMessage'),
            alternatives: [chord('Enter')],
        });
    }
    conversationRows.push(
        {
            id: 'insert-new-line',
            icon: 'return-down-forward-outline',
            label: t('keyboardShortcuts.insertNewLine'),
            alternatives: [context.enterToSend ? chord('Shift', 'Enter') : chord('Enter')],
        },
        {
            id: 'navigate-suggestions',
            icon: 'chevron-expand-outline',
            label: t('keyboardShortcuts.navigateSuggestions'),
            alternatives: [chord('ArrowUp'), chord('ArrowDown')],
        },
        {
            id: 'accept-suggestion',
            icon: 'checkmark-outline',
            label: t('keyboardShortcuts.acceptSuggestion'),
            alternatives: [chord('Enter'), chord('Tab')],
        },
        {
            id: 'close-suggestions',
            icon: 'close-outline',
            label: t('keyboardShortcuts.closeSuggestions'),
            alternatives: [chord('Escape')],
        },
        {
            id: 'stop-running-agent',
            icon: 'stop-circle-outline',
            label: t('keyboardShortcuts.stopRunningAgent'),
            detail: t('keyboardShortcuts.pressTwice'),
            alternatives: [chord('Escape', 'Escape')],
        },
    );

    const sections: ShortcutSection[] = [
        {
            id: 'common',
            title: t('keyboardShortcuts.common'),
            rows: commonRows,
        },
        {
            id: 'navigation',
            title: t('keyboardShortcuts.navigation'),
            rows: [
                {
                    id: 'close-or-go-back',
                    icon: 'arrow-back-outline',
                    label: t('keyboardShortcuts.closeOrGoBack'),
                    detail: t('keyboardShortcuts.closeOrGoBackDetail'),
                    alternatives: [chord('Escape')],
                },
            ],
        },
        {
            id: 'command-palette',
            title: t('keyboardShortcuts.commandPalette'),
            rows: [
                {
                    id: 'move-selection',
                    icon: 'swap-vertical-outline',
                    label: t('keyboardShortcuts.moveSelection'),
                    alternatives: [chord('ArrowUp'), chord('ArrowDown')],
                },
                {
                    id: 'run-selected',
                    icon: 'return-down-back-outline',
                    label: t('keyboardShortcuts.runSelected'),
                    alternatives: [chord('Enter')],
                },
                {
                    id: 'close-command-palette',
                    icon: 'close-outline',
                    label: t('keyboardShortcuts.closeCommandPalette'),
                    alternatives: [chord('Escape')],
                },
                {
                    id: 'run-numbered-result',
                    icon: 'keypad-outline',
                    label: t('keyboardShortcuts.runNumberedResult'),
                    alternatives: [chord('Alt', '1–9')],
                },
            ],
        },
        {
            id: 'conversation',
            title: t('keyboardShortcuts.conversation'),
            rows: conversationRows,
        },
    ];

    if (context.inTauri) {
        sections.push({
            id: 'desktop-app',
            title: t('keyboardShortcuts.desktopApp'),
            rows: [
                {
                    id: 'zoom-in',
                    icon: 'add-outline',
                    label: t('keyboardShortcuts.zoomIn'),
                    alternatives: [chord('Meta', '+')],
                },
                {
                    id: 'zoom-out',
                    icon: 'remove-outline',
                    label: t('keyboardShortcuts.zoomOut'),
                    alternatives: [chord('Meta', '-')],
                },
                {
                    id: 'reset-zoom',
                    icon: 'refresh-outline',
                    label: t('keyboardShortcuts.resetZoom'),
                    alternatives: [chord('Meta', '0')],
                },
            ],
        });
    }

    return sections;
}
