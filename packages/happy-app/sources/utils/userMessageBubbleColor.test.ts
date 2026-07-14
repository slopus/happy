import { describe, expect, it } from 'vitest';
import {
    DEFAULT_USER_MESSAGE_BUBBLE_COLOR,
    getNextUserMessageBubbleColor,
    normalizeUserMessageBubbleColor,
    resolveUserMessageBubbleColor,
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
});
