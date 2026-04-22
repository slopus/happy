export type TurnNavigationAction = 'prev' | 'next' | 'prevPage' | 'nextPage' | 'end';

export interface TurnNavigationKeyEvent {
    key: string;
    code?: string;
    altKey: boolean;
    shiftKey: boolean;
}

export const TURN_NAVIGATION_SHORTCUTS = {
    prevPage: 'Alt+Shift+↑',
    prev: 'Alt+↑',
    picker: 'Jump to turn',
    next: 'Alt+↓',
    nextPage: 'Alt+Shift+↓',
    end: 'Alt+.',
} as const;

export function getTurnNavigationAction(event: TurnNavigationKeyEvent): TurnNavigationAction | null {
    if (!event.altKey) return null;

    if (event.key === 'ArrowUp') {
        return event.shiftKey ? 'prevPage' : 'prev';
    }

    if (event.key === 'ArrowDown') {
        return event.shiftKey ? 'nextPage' : 'next';
    }

    if ((event.key === 'End' && event.shiftKey) || event.code === 'Period') {
        return 'end';
    }

    return null;
}

export function getTurnNavigationShortcut(action: keyof typeof TURN_NAVIGATION_SHORTCUTS): string {
    return TURN_NAVIGATION_SHORTCUTS[action];
}
