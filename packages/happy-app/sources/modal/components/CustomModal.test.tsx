// @vitest-environment jsdom

import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error react-test-renderer is only used for this component harness.
import TestRenderer from 'react-test-renderer';

const mocks = vi.hoisted(() => ({
    paletteClose: undefined as undefined | ((afterClose?: () => void) => void),
}));

vi.mock('@/components/CommandPalette/CommandPaletteModal', () => ({
    CommandPaletteModal: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock('react-native', async () => {
    // react-native-web 0.21 does not publish TypeScript declarations.
    // @ts-expect-error This test exercises its real modal DOM implementation.
    return import('react-native-web');
});

vi.mock('@expo/vector-icons', async () => {
    const ReactModule = await import('react');
    return {
        Ionicons: ({
            accessibilityElementsHidden: _accessibilityElementsHidden,
            importantForAccessibility: _importantForAccessibility,
            name,
            ...props
        }: any) => ReactModule.createElement('span', {
            ...props,
            'data-icon': name,
        }),
    };
});

vi.mock('react-native-unistyles', () => {
    const theme = {
        colors: {
            divider: '#ddd',
            groupped: { background: '#f5f5f5', sectionTitle: '#777' },
            shadow: { color: '#000', opacity: 0.2 },
            surface: '#fff',
            surfacePressed: '#eee',
            text: '#111',
            textSecondary: '#666',
        },
    };
    return {
        StyleSheet: {
            hairlineWidth: 1,
            create: (factory: any) => factory(theme),
        },
        useUnistyles: () => ({ theme }),
    };
});

vi.mock('@/constants/Typography', () => ({
    Typography: {
        default: () => ({ fontFamily: 'Test Sans' }),
        mono: () => ({ fontFamily: 'Test Mono' }),
    },
}));

vi.mock('@/text', () => ({ t: (key: string) => `localized:${key}` }));

vi.mock('@/components/CommandPalette', () => ({
    CommandPalette: ({ onClose }: { onClose: (afterClose?: () => void) => void }) => {
        mocks.paletteClose = onClose;
        return null;
    },
}));

import { CommandPalette } from '@/components/CommandPalette';
import { KeyboardShortcutsModal } from '@/components/KeyboardShortcuts/KeyboardShortcutsModal';
import { CustomModal } from './CustomModal';

describe('CustomModal command palette close order', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
        mocks.paletteClose = undefined;
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it('runs a selected command only in the task after the palette has unmounted', () => {
        const events: string[] = [];
        const onClose = vi.fn(() => events.push('provider-close'));
        const action = vi.fn(() => events.push('command-action'));
        let renderer: TestRenderer.ReactTestRenderer;

        act(() => {
            renderer = TestRenderer.create(
                <CustomModal
                    config={{
                        id: 'command-palette',
                        type: 'custom',
                        component: CommandPalette,
                        props: { commands: [] },
                    }}
                    onClose={onClose}
                />,
            );
        });

        act(() => mocks.paletteClose?.(action));
        expect(events).toEqual(['provider-close']);

        act(() => renderer!.unmount());
        expect(events).toEqual(['provider-close']);

        act(() => vi.runAllTimers());
        expect(events).toEqual(['provider-close', 'command-action']);
    });
});

describe('CustomModal keyboard shortcuts wrapper in React Native Web', () => {
    let container: HTMLDivElement;
    let opener: HTMLButtonElement;
    let root: Root | undefined;

    beforeEach(() => {
        vi.useFakeTimers();
        vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
        container = document.createElement('div');
        opener = document.createElement('button');
        opener.textContent = 'Open shortcuts';
        document.body.append(opener, container);
        opener.focus();
    });

    afterEach(() => {
        if (root) {
            act(() => root?.unmount());
        }
        root = undefined;
        container.remove();
        opener.remove();
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it('provides one named modal boundary and closes from the panel or backdrop', () => {
        const onClose = vi.fn();
        act(() => {
            root = createRoot(container);
            root.render(
                <CustomModal
                    config={{
                        id: 'keyboard-shortcuts',
                        type: 'custom',
                        component: KeyboardShortcutsModal,
                        accessibilityLabel: 'localized:keyboardShortcuts.title',
                        props: { sections: [] },
                    }}
                    onClose={onClose}
                />,
            );
        });
        act(() => vi.advanceTimersByTime(0));

        const modalBoundary = document.body.querySelector<HTMLElement>('[aria-modal="true"]');
        const animationContainer = modalBoundary?.parentElement?.parentElement;
        act(() => animationContainer?.dispatchEvent(new Event('animationend', { bubbles: true })));

        const dialogs = Array.from(document.body.querySelectorAll<HTMLElement>('[role="dialog"]'));
        expect(dialogs).toHaveLength(1);
        expect(dialogs[0]?.getAttribute('aria-modal')).toBe('true');
        expect(dialogs[0]?.getAttribute('aria-label')).toBe('localized:keyboardShortcuts.title');

        act(() => document.body.querySelector<HTMLElement>(
            '[data-testid="keyboard-shortcuts-close"]',
        )?.click());
        expect(onClose).toHaveBeenCalledOnce();

        act(() => document.body.querySelector<HTMLElement>(
            '[data-testid="base-modal-backdrop"]',
        )?.click());
        expect(onClose).toHaveBeenCalledTimes(2);

        act(() => root?.unmount());
        root = undefined;
        expect(document.activeElement).toBe(opener);
    });
});
