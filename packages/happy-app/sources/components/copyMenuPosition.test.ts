import { describe, expect, it } from 'vitest';
import { resolveCopyMenuPosition } from './copyMenuPosition';

describe('resolveCopyMenuPosition', () => {
    it('centers the menu above the trigger point when there is enough room', () => {
        expect(resolveCopyMenuPosition({
            triggerX: 200,
            triggerY: 320,
            menuWidth: 120,
            menuHeight: 40,
            viewportWidth: 400,
            viewportHeight: 800,
        })).toEqual({
            left: 140,
            top: 268,
            arrowLeft: 56,
        });
    });

    it('keeps the menu inside the horizontal viewport bounds', () => {
        expect(resolveCopyMenuPosition({
            triggerX: 24,
            triggerY: 320,
            menuWidth: 120,
            menuHeight: 40,
            viewportWidth: 400,
            viewportHeight: 800,
        })).toEqual({
            left: 12,
            top: 268,
            arrowLeft: 8,
        });

        expect(resolveCopyMenuPosition({
            triggerX: 388,
            triggerY: 320,
            menuWidth: 120,
            menuHeight: 40,
            viewportWidth: 400,
            viewportHeight: 800,
        })).toEqual({
            left: 268,
            top: 268,
            arrowLeft: 104,
        });
    });

    it('keeps the menu inside the top viewport bound', () => {
        expect(resolveCopyMenuPosition({
            triggerX: 200,
            triggerY: 32,
            menuWidth: 120,
            menuHeight: 40,
            viewportWidth: 400,
            viewportHeight: 800,
        })).toEqual({
            left: 140,
            top: 12,
            arrowLeft: 56,
        });
    });
});
