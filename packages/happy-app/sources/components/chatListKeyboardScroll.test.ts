import { describe, expect, it } from 'vitest';
import {
    CHAT_LIST_KEYBOARD_LINE_SCROLL,
    getInvertedChatListKeyboardScrollDelta,
} from './chatListKeyboardScroll';

const VIEWPORT_HEIGHT = 720;

function keyboardEvent(
    key: string,
    overrides: Partial<Parameters<typeof getInvertedChatListKeyboardScrollDelta>[0]> = {},
) {
    return {
        key,
        defaultPrevented: false,
        altKey: false,
        ctrlKey: false,
        metaKey: false,
        shiftKey: false,
        ...overrides,
    };
}

describe('inverted chat list keyboard scrolling', () => {
    it('maps standard reading-navigation keys to the inverse DOM scroll delta', () => {
        expect(getInvertedChatListKeyboardScrollDelta(keyboardEvent('ArrowDown'), VIEWPORT_HEIGHT))
            .toBe(-CHAT_LIST_KEYBOARD_LINE_SCROLL);
        expect(getInvertedChatListKeyboardScrollDelta(keyboardEvent('ArrowUp'), VIEWPORT_HEIGHT))
            .toBe(CHAT_LIST_KEYBOARD_LINE_SCROLL);
        expect(getInvertedChatListKeyboardScrollDelta(keyboardEvent('PageDown'), VIEWPORT_HEIGHT))
            .toBe(-VIEWPORT_HEIGHT);
        expect(getInvertedChatListKeyboardScrollDelta(keyboardEvent('PageUp'), VIEWPORT_HEIGHT))
            .toBe(VIEWPORT_HEIGHT);
        expect(getInvertedChatListKeyboardScrollDelta(keyboardEvent(' '), VIEWPORT_HEIGHT))
            .toBe(-VIEWPORT_HEIGHT);
        expect(getInvertedChatListKeyboardScrollDelta(keyboardEvent('Spacebar'), VIEWPORT_HEIGHT))
            .toBe(-VIEWPORT_HEIGHT);
    });

    it('leaves handled, modified, and unrelated key events alone', () => {
        expect(getInvertedChatListKeyboardScrollDelta(
            keyboardEvent('ArrowDown', { defaultPrevented: true }),
            VIEWPORT_HEIGHT,
        )).toBeNull();
        expect(getInvertedChatListKeyboardScrollDelta(
            keyboardEvent('ArrowDown', { metaKey: true }),
            VIEWPORT_HEIGHT,
        )).toBeNull();
        expect(getInvertedChatListKeyboardScrollDelta(
            keyboardEvent('ArrowDown', { ctrlKey: true }),
            VIEWPORT_HEIGHT,
        )).toBeNull();
        expect(getInvertedChatListKeyboardScrollDelta(
            keyboardEvent('ArrowDown', { altKey: true }),
            VIEWPORT_HEIGHT,
        )).toBeNull();
        expect(getInvertedChatListKeyboardScrollDelta(
            keyboardEvent('ArrowDown', { shiftKey: true }),
            VIEWPORT_HEIGHT,
        )).toBeNull();
        expect(getInvertedChatListKeyboardScrollDelta(keyboardEvent('Home'), VIEWPORT_HEIGHT))
            .toBeNull();
    });
});
