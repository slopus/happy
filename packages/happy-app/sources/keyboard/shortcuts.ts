export type GlobalShortcutId = 'commandPalette' | 'newSession' | 'settings';
export type ShortcutModifier = 'meta' | 'control';

export interface KeyboardShortcutEvent {
    key: string;
    code?: string;
    metaKey: boolean;
    ctrlKey: boolean;
    altKey: boolean;
    shiftKey: boolean;
    isComposing?: boolean;
    repeat?: boolean;
    getModifierState?: (key: string) => boolean;
}

export interface NavigatorPlatformLike {
    platform?: string;
    userAgent?: string;
    userAgentData?: {
        platform?: string;
    };
}

export type SessionActionShortcutId =
    | 'details'
    | 'resume'
    | 'fork'
    | 'duplicate'
    | 'copy-metadata'
    | 'copy-metadata-and-logs'
    | 'archive';

export type SidebarPickerShortcutId = 'changes' | 'allFiles' | 'newSideChat';

export interface ShortcutChord {
    key: string;
    code: string;
    keyLabel: string;
    altKey?: boolean;
    shiftKey?: boolean;
}

export const SESSION_ACTION_SHORTCUTS: Readonly<Record<SessionActionShortcutId, ShortcutChord>> = {
    details: { key: 'o', code: 'KeyO', keyLabel: 'O', altKey: true },
    resume: { key: 'r', code: 'KeyR', keyLabel: 'R', altKey: true },
    fork: { key: 'f', code: 'KeyF', keyLabel: 'F', altKey: true },
    duplicate: { key: 'd', code: 'KeyD', keyLabel: 'D', altKey: true, shiftKey: true },
    'copy-metadata': { key: 'm', code: 'KeyM', keyLabel: 'M', altKey: true },
    'copy-metadata-and-logs': { key: 'm', code: 'KeyM', keyLabel: 'M', altKey: true, shiftKey: true },
    archive: { key: 'a', code: 'KeyA', keyLabel: 'A', shiftKey: true },
};

export const SIDEBAR_PICKER_SHORTCUTS: Readonly<Record<SidebarPickerShortcutId, ShortcutChord>> = {
    changes: { key: 'c', code: 'KeyC', keyLabel: 'C', altKey: true },
    allFiles: { key: 'f', code: 'KeyF', keyLabel: 'F', altKey: true },
    newSideChat: { key: 's', code: 'KeyS', keyLabel: 'S', altKey: true },
};

export const GLOBAL_SHORTCUTS: ReadonlyArray<{
    id: GlobalShortcutId;
    key: string;
    code: string;
    keyLabel: string;
}> = [
    { id: 'commandPalette', key: 'k', code: 'KeyK', keyLabel: 'K' },
    { id: 'newSession', key: 'n', code: 'KeyN', keyLabel: 'N' },
    { id: 'settings', key: ',', code: 'Comma', keyLabel: ',' },
];

export function getGlobalShortcutId(
    event: KeyboardShortcutEvent,
    browserSafe = false,
): GlobalShortcutId | null {
    if (
        event.isComposing
        || event.getModifierState?.('AltGraph')
        || event.altKey !== browserSafe
        || event.shiftKey
        || (!event.metaKey && !event.ctrlKey)
    ) {
        return null;
    }

    return GLOBAL_SHORTCUTS.find((shortcut) => event.code
        ? shortcut.code === event.code
        : shortcut.key === event.key.toLowerCase()
    )?.id ?? null;
}

export function getRecentSessionShortcutIndex(
    event: KeyboardShortcutEvent,
    browserSafe = false,
): number | null {
    if (
        event.isComposing
        || event.getModifierState?.('AltGraph')
        || event.altKey !== browserSafe
        || event.shiftKey
        || (!event.metaKey && !event.ctrlKey)
    ) {
        return null;
    }

    const codeMatch = event.code?.match(/^(?:Digit|Numpad)([1-9])$/);
    if (codeMatch) {
        return Number(codeMatch[1]) - 1;
    }
    return /^[1-9]$/.test(event.key) ? Number(event.key) - 1 : null;
}

export function getPressedShortcutModifier(event: Pick<KeyboardShortcutEvent, 'key' | 'altKey'>): ShortcutModifier | null {
    if (event.altKey) {
        return null;
    }
    if (event.key === 'Meta') {
        return 'meta';
    }
    if (event.key === 'Control') {
        return 'control';
    }
    return null;
}

export function getPreferredShortcutModifier(navigatorValue?: NavigatorPlatformLike): ShortcutModifier {
    const platform = navigatorValue?.userAgentData?.platform
        || navigatorValue?.platform
        || navigatorValue?.userAgent
        || '';

    return /Mac|iPhone|iPad|iPod/i.test(platform) ? 'meta' : 'control';
}

export function getShortcutModifierLabel(modifier: ShortcutModifier): string {
    return modifier === 'meta' ? '⌘' : 'Ctrl';
}

export function formatShortcut(
    modifier: ShortcutModifier,
    keyLabel: string,
    browserSafe = false,
): string {
    const modifierLabel = getShortcutModifierLabel(modifier);
    if (modifier === 'meta') {
        return `${browserSafe ? '⌥' : ''}${modifierLabel}${keyLabel}`;
    }
    return `${modifierLabel}${browserSafe ? '+Alt' : ''}+${keyLabel}`;
}

export function formatShortcutChord(modifier: ShortcutModifier, chord: ShortcutChord): string {
    if (modifier === 'meta') {
        return `${chord.altKey ? '⌥' : ''}${chord.shiftKey ? '⇧' : ''}⌘${chord.keyLabel}`;
    }

    return [
        'Ctrl',
        chord.altKey ? 'Alt' : null,
        chord.shiftKey ? 'Shift' : null,
        chord.keyLabel,
    ].filter(Boolean).join('+');
}

export function matchesShortcutChord(
    event: KeyboardShortcutEvent,
    modifier: ShortcutModifier,
    chord: ShortcutChord,
): boolean {
    if (event.isComposing || event.repeat || event.getModifierState?.('AltGraph')) {
        return false;
    }

    const hasPrimaryModifier = modifier === 'meta'
        ? event.metaKey && !event.ctrlKey
        : event.ctrlKey && !event.metaKey;

    return hasPrimaryModifier
        && event.altKey === Boolean(chord.altKey)
        && event.shiftKey === Boolean(chord.shiftKey)
        && (event.code ? event.code === chord.code : event.key.toLowerCase() === chord.key);
}
