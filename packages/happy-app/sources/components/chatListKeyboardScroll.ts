interface KeyboardScrollEvent {
    key: string;
    defaultPrevented: boolean;
    altKey: boolean;
    ctrlKey: boolean;
    metaKey: boolean;
    shiftKey: boolean;
}

export const CHAT_LIST_KEYBOARD_LINE_SCROLL = 48;

export function getInvertedChatListKeyboardScrollDelta(
    event: KeyboardScrollEvent,
    viewportHeight: number,
): number | null {
    if (event.defaultPrevented) return null;
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return null;

    switch (event.key) {
        case 'ArrowDown':
            return -CHAT_LIST_KEYBOARD_LINE_SCROLL;
        case 'ArrowUp':
            return CHAT_LIST_KEYBOARD_LINE_SCROLL;
        case 'PageDown':
        case ' ':
        case 'Spacebar':
            return -viewportHeight;
        case 'PageUp':
            return viewportHeight;
        default:
            return null;
    }
}
