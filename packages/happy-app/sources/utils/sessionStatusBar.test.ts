import { describe, expect, it } from 'vitest';
import {
    clampContextSize,
    getContextUsageLevel,
    getContextUsagePercentage,
    getPathBasename,
} from './sessionStatusBar';

describe('session status bar helpers', () => {
    it('extracts path basenames across path styles', () => {
        expect(getPathBasename('/Users/alice/project')).toBe('project');
        expect(getPathBasename('C:\\Users\\alice\\project')).toBe('project');
        expect(getPathBasename('/')).toBe('/');
        expect(getPathBasename('')).toBe(null);
        expect(getPathBasename(null)).toBe(null);
    });

    it('clamps context values to the valid range', () => {
        expect(clampContextSize(-10, 100)).toBe(0);
        expect(clampContextSize(50, 100)).toBe(50);
        expect(clampContextSize(120, 100)).toBe(100);
        expect(clampContextSize(Number.NaN, 100)).toBe(0);
    });

    it('calculates context percentages and levels', () => {
        expect(getContextUsagePercentage(45, 100)).toBe(45);
        expect(getContextUsageLevel(89, 100)).toBe('normal');
        expect(getContextUsageLevel(90, 100)).toBe('warning');
        expect(getContextUsageLevel(95, 100)).toBe('critical');
    });
});
