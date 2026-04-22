import { describe, expect, it } from 'vitest';
import {
    TURN_NAVIGATION_SHORTCUTS,
    getTurnNavigationAction,
    getTurnNavigationShortcut,
} from './turnNavigationKeyboard';

describe('getTurnNavigationAction', () => {
    it('returns null when Alt is not pressed', () => {
        expect(getTurnNavigationAction({
            key: 'ArrowUp',
            code: 'ArrowUp',
            altKey: false,
            shiftKey: false,
        })).toBeNull();
    });

    it('maps Alt+ArrowUp to previous turn', () => {
        expect(getTurnNavigationAction({
            key: 'ArrowUp',
            code: 'ArrowUp',
            altKey: true,
            shiftKey: false,
        })).toBe('prev');
    });

    it('maps Alt+Shift+ArrowUp to previous page', () => {
        expect(getTurnNavigationAction({
            key: 'ArrowUp',
            code: 'ArrowUp',
            altKey: true,
            shiftKey: true,
        })).toBe('prevPage');
    });

    it('maps Alt+ArrowDown to next turn', () => {
        expect(getTurnNavigationAction({
            key: 'ArrowDown',
            code: 'ArrowDown',
            altKey: true,
            shiftKey: false,
        })).toBe('next');
    });

    it('maps Alt+Shift+ArrowDown to next page', () => {
        expect(getTurnNavigationAction({
            key: 'ArrowDown',
            code: 'ArrowDown',
            altKey: true,
            shiftKey: true,
        })).toBe('nextPage');
    });

    it('maps the physical Period key to jump to latest even when the produced key changes', () => {
        expect(getTurnNavigationAction({
            key: '>',
            code: 'Period',
            altKey: true,
            shiftKey: false,
        })).toBe('end');
    });

    it('still supports Alt+Shift+End for jump to latest', () => {
        expect(getTurnNavigationAction({
            key: 'End',
            code: 'End',
            altKey: true,
            shiftKey: true,
        })).toBe('end');
    });
});

describe('turn navigation shortcuts', () => {
    it('exposes the expected labels for the navigator buttons', () => {
        expect(TURN_NAVIGATION_SHORTCUTS).toEqual({
            prevPage: 'Alt+Shift+↑',
            prev: 'Alt+↑',
            picker: 'Jump to turn',
            next: 'Alt+↓',
            nextPage: 'Alt+Shift+↓',
            end: 'Alt+.',
        });
    });

    it('returns labels for each supported action', () => {
        expect(getTurnNavigationShortcut('prevPage')).toBe('Alt+Shift+↑');
        expect(getTurnNavigationShortcut('prev')).toBe('Alt+↑');
        expect(getTurnNavigationShortcut('next')).toBe('Alt+↓');
        expect(getTurnNavigationShortcut('nextPage')).toBe('Alt+Shift+↓');
        expect(getTurnNavigationShortcut('end')).toBe('Alt+.');
    });
});
