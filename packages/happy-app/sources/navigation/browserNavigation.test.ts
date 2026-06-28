import { describe, expect, test } from 'vitest';
import {
    applyRouteHistoryPathname,
    canUseRouteBack,
    createRouteHistory,
    getKeyboardNavigationDirection,
    getMouseNavigationDirection,
} from './browserNavigation';

describe('browser navigation shortcuts', () => {
    test('initial route sync does not create a back entry', () => {
        const history = createRouteHistory('/session/one');

        const next = applyRouteHistoryPathname(history, '/session/one', null);

        expect(next).toEqual({
            stack: ['/session/one'],
            cursor: 0,
        });
    });

    test('regular navigation pushes entries and trims forward history', () => {
        let history = createRouteHistory('/one');
        history = applyRouteHistoryPathname(history, '/two', null);
        history = applyRouteHistoryPathname(history, '/three', null);
        history = applyRouteHistoryPathname(history, '/two', 'back');

        const next = applyRouteHistoryPathname(history, '/four', null);

        expect(next).toEqual({
            stack: ['/one', '/two', '/four'],
            cursor: 2,
        });
    });

    test('marked back and forward movements move the cursor instead of pushing duplicates', () => {
        let history = createRouteHistory('/one');
        history = applyRouteHistoryPathname(history, '/two', null);
        history = applyRouteHistoryPathname(history, '/three', null);

        history = applyRouteHistoryPathname(history, '/two', 'back');
        expect(history).toEqual({
            stack: ['/one', '/two', '/three'],
            cursor: 1,
        });

        history = applyRouteHistoryPathname(history, '/three', 'forward');
        expect(history).toEqual({
            stack: ['/one', '/two', '/three'],
            cursor: 2,
        });
    });

    test('route back only runs when React Navigation can actually go back', () => {
        let history = createRouteHistory('/');
        history = applyRouteHistoryPathname(history, '/session/one', null);

        expect(canUseRouteBack(history, true)).toBe(true);
        expect(canUseRouteBack(history, false)).toBe(false);
    });

    test('mouse side buttons map to browser history directions', () => {
        expect(getMouseNavigationDirection({ button: 3 })).toBe('back');
        expect(getMouseNavigationDirection({ button: 4 })).toBe('forward');
        expect(getMouseNavigationDirection({ button: 1 })).toBeNull();
    });

    test('Escape maps to back only when it is unmodified and unhandled', () => {
        expect(getKeyboardNavigationDirection({
            key: 'Escape',
            defaultPrevented: false,
            altKey: false,
            ctrlKey: false,
            metaKey: false,
            shiftKey: false,
        })).toBe('back');
        expect(getKeyboardNavigationDirection({
            key: 'Escape',
            defaultPrevented: true,
            altKey: false,
            ctrlKey: false,
            metaKey: false,
            shiftKey: false,
        })).toBeNull();
        expect(getKeyboardNavigationDirection({
            key: 'Escape',
            defaultPrevented: false,
            altKey: false,
            ctrlKey: false,
            metaKey: true,
            shiftKey: false,
        })).toBeNull();
    });
});
