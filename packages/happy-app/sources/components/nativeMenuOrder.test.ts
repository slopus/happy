import { describe, expect, it } from 'vitest';
import { orderNativeMenuItems } from './nativeMenuOrder';

describe('orderNativeMenuItems', () => {
    // The bug this exists for: iOS printed the harness picker upside down.
    it('reverses on iOS so an upward menu reads in the given order', () => {
        const harnesses = ['Claude Code', 'Codex', 'Antigravity', 'Happy'];
        expect(orderNativeMenuItems(harnesses, 'ios')).toEqual([
            'Happy',
            'Antigravity',
            'Codex',
            'Claude Code',
        ]);
    });

    it('leaves Android and web alone, since both draw top-down', () => {
        const modes = ['Auto', 'Edits', 'Plan', 'Yolo', 'Default'];
        expect(orderNativeMenuItems(modes, 'android')).toEqual(modes);
        expect(orderNativeMenuItems(modes, 'web')).toEqual(modes);
    });

    it('does not mutate the caller\'s array', () => {
        const modes = ['Auto', 'Default'];
        orderNativeMenuItems(modes, 'ios');
        expect(modes).toEqual(['Auto', 'Default']);
    });
});
