import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatHeaderView } from './ChatHeaderView';

// react-test-renderer does not publish TypeScript declarations with the package.
// @ts-expect-error The test only needs the create/unmount surface.
import TestRenderer from 'react-test-renderer';

vi.mock('react-native', () => ({
    Platform: { OS: 'web' },
    Pressable: 'Pressable',
    Text: 'Text',
    View: 'View',
}));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0 }) }));
vi.mock('@/constants/Typography', () => ({ Typography: { default: () => ({}), mono: () => ({}) } }));
vi.mock('@/utils/responsive', () => ({ useHeaderHeight: () => 52, useIsTablet: () => true }));
vi.mock('@/components/layout', () => ({ layout: { headerMaxWidth: 800 } }));
vi.mock('react-native-unistyles', () => ({
    StyleSheet: {
        create: (factory: unknown) => {
            const theme = {
                colors: {
                    header: { background: '#fff', tint: '#111' },
                    textSecondary: '#666',
                },
            };
            const created = (typeof factory === 'function'
                ? (factory as (value: typeof theme) => Record<string, any>)(theme)
                : factory) as Record<string, any>;
            const variants = created.rightSlot?.variants?.rightSlotDensity;
            const rightSlotBase = { ...created.rightSlot };
            delete rightSlotBase.variants;
            created.rightSlot = rightSlotBase;
            created.useVariants = ({ rightSlotDensity }: { rightSlotDensity: 'regular' | 'compact' }) => {
                created.rightSlot = {
                    ...rightSlotBase,
                    ...variants?.[rightSlotDensity],
                };
            };
            return created;
        },
    },
    useUnistyles: () => ({
        theme: {
            colors: {
                header: { background: '#fff', tint: '#111' },
                textSecondary: '#666',
            },
        },
    }),
}));

function renderRightSlot(compactRightSlot: boolean) {
    let renderer: any;
    act(() => {
        renderer = TestRenderer.create(
            <ChatHeaderView
                compactRightSlot={compactRightSlot}
                rightSlot={React.createElement('RightSlot')}
                title="Session"
            />,
        );
    });
    const slot = renderer.root.findByType('RightSlot').parent;
    const flattenedStyle = Array.isArray(slot.props.style)
        ? Object.assign({}, ...slot.props.style.filter(Boolean))
        : slot.props.style;
    return { flattenedStyle, renderer };
}

describe('ChatHeaderView right slot spacing', () => {
    const originalConsoleError = console.error;
    let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
        consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation((...values: unknown[]) => {
            if (values[0] === 'react-test-renderer is deprecated. See https://react.dev/warnings/react-test-renderer') return;
            originalConsoleError(...values);
        });
    });

    afterEach(() => consoleErrorSpy.mockRestore());

    it('keeps the default separation for unconstrained headers', () => {
        const { flattenedStyle, renderer } = renderRightSlot(false);
        expect(flattenedStyle.marginLeft).toBe(12);
        act(() => renderer.unmount());
    });

    it('reclaims only the right-slot margin for compact session headers', () => {
        const { flattenedStyle, renderer } = renderRightSlot(true);
        expect(flattenedStyle.marginLeft).toBe(0);
        act(() => renderer.unmount());
    });
});
