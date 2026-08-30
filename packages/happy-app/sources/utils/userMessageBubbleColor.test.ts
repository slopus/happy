import { describe, expect, it } from 'vitest';
import {
    DEFAULT_USER_MESSAGE_BUBBLE_COLOR,
    getNextUserMessageBubbleColor,
    normalizeUserMessageBubbleColor,
    resolveUserMessageBubbleColor,
    resolveUserMessageBubbleGlassColor,
    USER_MESSAGE_BUBBLE_COLORS,
} from './userMessageBubbleColor';

describe('user message bubble color', () => {
    it('falls back to the default color for unknown values', () => {
        expect(normalizeUserMessageBubbleColor('unknown')).toBe(DEFAULT_USER_MESSAGE_BUBBLE_COLOR);
        expect(normalizeUserMessageBubbleColor(null)).toBe(DEFAULT_USER_MESSAGE_BUBBLE_COLOR);
    });

    it('cycles through presets', () => {
        expect(getNextUserMessageBubbleColor('gray')).toBe('blue');
        expect(getNextUserMessageBubbleColor(USER_MESSAGE_BUBBLE_COLORS[USER_MESSAGE_BUBBLE_COLORS.length - 1])).toBe('gray');
        expect(getNextUserMessageBubbleColor('missing')).toBe('blue');
    });

    it('resolves different palettes for light and dark themes', () => {
        expect(resolveUserMessageBubbleColor('blue', false)).toEqual({
            background: '#E8F2FF',
            border: '#9CC9FF',
            indicator: '#0A84FF',
        });
        expect(resolveUserMessageBubbleColor('blue', true)).toEqual({
            background: '#17324D',
            border: '#2F6EA8',
            indicator: '#64B5FF',
        });
    });

    it('resolves translucent glass colors for every preset', () => {
        expect(resolveUserMessageBubbleGlassColor('green', true)).toEqual({
            background: 'rgba(23, 58, 39, 0.46)',
            border: 'rgba(61, 139, 88, 0.56)',
            tint: 'rgba(101, 211, 133, 0.18)',
        });
        expect(resolveUserMessageBubbleGlassColor('blue', false)).toEqual({
            background: 'rgba(232, 242, 255, 0.54)',
            border: 'rgba(156, 201, 255, 0.7)',
            tint: 'rgba(10, 132, 255, 0.14)',
        });
        expect(resolveUserMessageBubbleGlassColor('gray', true).border).toBe('rgba(255, 255, 255, 0.18)');
    });
});
