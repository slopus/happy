import { describe, expect, it } from 'vitest';
import { getRestoreLayout, RESTORE_DESKTOP_BREAKPOINT } from './restoreLayout';

describe('设备连接页布局断点', () => {
    it.each([
        [390, 'compact'],
        [RESTORE_DESKTOP_BREAKPOINT - 1, 'compact'],
        [RESTORE_DESKTOP_BREAKPOINT, 'desktop'],
        [1470, 'desktop'],
        [2552, 'desktop'],
    ] as const)('%dpx 使用 %s 布局', (width, expected) => {
        expect(getRestoreLayout(width)).toBe(expected);
    });
});
