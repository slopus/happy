import { describe, expect, it } from 'vitest';

import { resolvePermissionStyle, resolveSelectedOption } from './newSessionModeSelection';

const modes = [
    { key: 'default', name: 'Default' },
    { key: 'yolo', name: 'YOLO' },
];

describe('new session mode selection', () => {
    it('resolves the indexed option and falls back to the first one', () => {
        expect(resolveSelectedOption(modes, 1)).toEqual({ key: 'yolo', name: 'YOLO' });
        expect(resolveSelectedOption(modes, 7)).toEqual({ key: 'default', name: 'Default' });
    });

    it('returns null when a Rig machine publishes no options at all', () => {
        // Rig machines with no `operatingModes` reach the composer with an
        // empty permission catalog; the screen must render without a pick.
        expect(resolveSelectedOption([], 0)).toBeNull();
        expect(resolveSelectedOption([], 3)).toBeNull();
    });

    it('has no permission accent without a selection or for the default mode', () => {
        expect(resolvePermissionStyle(null)).toBeNull();
        expect(resolvePermissionStyle(undefined)).toBeNull();
        expect(resolvePermissionStyle(resolveSelectedOption(modes, 0))).toBeNull();
        expect(resolvePermissionStyle(resolveSelectedOption([], 0))).toBeNull();
    });

    it('accents the permission modes that change agent behaviour', () => {
        expect(resolvePermissionStyle({ key: 'yolo' })?.color).toBe('#F87171');
        expect(resolvePermissionStyle({ key: 'plan' })?.icon).toBe('pause');
        expect(resolvePermissionStyle({ key: 'read-only' })?.icon).toBe('pause');
    });
});
