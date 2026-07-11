export const USER_MESSAGE_BUBBLE_COLORS = ['blue', 'green', 'purple', 'rose', 'sand', 'gray'] as const;

export type UserMessageBubbleColor = typeof USER_MESSAGE_BUBBLE_COLORS[number];

export type UserMessageBubblePalette = {
    background: string;
    border: string;
    indicator: string;
};

export const DEFAULT_USER_MESSAGE_BUBBLE_COLOR: UserMessageBubbleColor = 'blue';

const lightPalettes: Record<UserMessageBubbleColor, UserMessageBubblePalette> = {
    blue: {
        background: '#E8F2FF',
        border: '#9CC9FF',
        indicator: '#0A84FF',
    },
    green: {
        background: '#E9F7EF',
        border: '#96D6AE',
        indicator: '#34C759',
    },
    purple: {
        background: '#F0EBFF',
        border: '#B7A2FF',
        indicator: '#7D68CF',
    },
    rose: {
        background: '#FFF0F5',
        border: '#F3A4BF',
        indicator: '#D85D85',
    },
    sand: {
        background: '#F1E7D0',
        border: '#D9C292',
        indicator: '#B28B3D',
    },
    gray: {
        background: '#F0F2F5',
        border: '#CCD2DA',
        indicator: '#8E8E93',
    },
};

const darkPalettes: Record<UserMessageBubbleColor, UserMessageBubblePalette> = {
    blue: {
        background: '#17324D',
        border: '#2F6EA8',
        indicator: '#64B5FF',
    },
    green: {
        background: '#173A27',
        border: '#3D8B58',
        indicator: '#65D385',
    },
    purple: {
        background: '#2B214A',
        border: '#7D68CF',
        indicator: '#B8A8FF',
    },
    rose: {
        background: '#462232',
        border: '#C85E82',
        indicator: '#FF9DBB',
    },
    sand: {
        background: '#3A3326',
        border: '#8D7A55',
        indicator: '#E8C878',
    },
    gray: {
        background: '#2C2C2E',
        border: '#505054',
        indicator: '#8E8E93',
    },
};

export function isUserMessageBubbleColor(value: unknown): value is UserMessageBubbleColor {
    return typeof value === 'string' && USER_MESSAGE_BUBBLE_COLORS.includes(value as UserMessageBubbleColor);
}

export function normalizeUserMessageBubbleColor(value: unknown): UserMessageBubbleColor {
    return isUserMessageBubbleColor(value) ? value : DEFAULT_USER_MESSAGE_BUBBLE_COLOR;
}

export function getNextUserMessageBubbleColor(value: unknown): UserMessageBubbleColor {
    const color = normalizeUserMessageBubbleColor(value);
    const currentIndex = USER_MESSAGE_BUBBLE_COLORS.indexOf(color);
    return USER_MESSAGE_BUBBLE_COLORS[(currentIndex + 1) % USER_MESSAGE_BUBBLE_COLORS.length];
}

export function resolveUserMessageBubbleColor(value: unknown, isDark: boolean): UserMessageBubblePalette {
    const color = normalizeUserMessageBubbleColor(value);
    return (isDark ? darkPalettes : lightPalettes)[color];
}
