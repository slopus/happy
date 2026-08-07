// @vitest-environment jsdom

import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ShortcutSection } from './shortcutCatalog';

vi.mock('react-native', async () => {
    // react-native-web 0.21 does not publish TypeScript declarations.
    // @ts-expect-error The test exercises its runtime DOM implementation directly.
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
        }: any) => ReactModule.createElement('span', { ...props, 'data-icon': name }),
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

import { KeyboardShortcutsModal } from './KeyboardShortcutsModal';

const sections: ShortcutSection[] = [
    {
        id: 'common',
        title: 'First section',
        rows: [
            {
                id: 'first-action',
                icon: 'terminal-outline',
                label: 'First action',
                detail: 'First detail',
                alternatives: [['⌘', 'K'], ['Ctrl', 'K']],
            },
            {
                id: 'second-action',
                icon: 'settings-outline',
                label: 'Second action',
                alternatives: [['Escape']],
            },
        ],
    },
    {
        id: 'navigation',
        title: 'Second section',
        rows: [
            {
                id: 'third-action',
                icon: 'arrow-back-outline',
                label: 'Third action',
                alternatives: [['Shift', 'Enter']],
            },
        ],
    },
];

describe('KeyboardShortcutsModal in React Native Web', () => {
    let container: HTMLDivElement;
    let opener: HTMLButtonElement;
    let root: Root | undefined;

    beforeEach(() => {
        container = document.createElement('div');
        opener = document.createElement('button');
        opener.textContent = 'Open shortcuts';
        document.body.append(opener, container);
        opener.focus();
        (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    });

    afterEach(() => {
        if (root) {
            act(() => root?.unmount());
        }
        root = undefined;
        container.remove();
        opener.remove();
        vi.clearAllMocks();
    });

    function renderModal(onClose = vi.fn()) {
        act(() => {
            root = createRoot(container);
            root.render(<KeyboardShortcutsModal onClose={onClose} sections={sections} />);
        });
        return onClose;
    }

    function getByTestID(testID: string): HTMLElement {
        const element = container.querySelector<HTMLElement>(`[data-testid="${testID}"]`);
        if (!element) throw new Error(`Missing testID: ${testID}`);
        return element;
    }

    it('exposes the localized panel as an actual modal dialog with a fixed header and scrolling body', () => {
        renderModal();

        const panel = getByTestID('keyboard-shortcuts-dialog');
        expect(panel.getAttribute('role')).toBe('dialog');
        expect(panel.getAttribute('aria-modal')).toBe('true');
        expect(panel.getAttribute('aria-label')).toBe('localized:keyboardShortcuts.title');
        expect(Array.from(panel.children).map((child) => child.getAttribute('data-testid'))).toEqual([
            'keyboard-shortcuts-header',
            'keyboard-shortcuts-scroll',
        ]);
        expect(getByTestID('keyboard-shortcuts-title').textContent)
            .toBe('localized:keyboardShortcuts.title');
        expect(getByTestID('keyboard-shortcuts-close').getAttribute('aria-label'))
            .toBe('localized:keyboardShortcuts.close');

        const panelStyle = getComputedStyle(panel);
        expect(panelStyle.width).toBe('calc(100vw - 32px)');
        expect(panelStyle.maxWidth).toBe('720px');
        expect(panelStyle.maxHeight).toBe('76vh');
        expect(panelStyle.borderTopLeftRadius).toBe('14px');
    });

    it('preserves section and row order in the rendered DOM', () => {
        renderModal();

        expect(Array.from(container.querySelectorAll<HTMLElement>(
            '[data-testid^="keyboard-shortcut-section-"]',
        )).map((element) => element.dataset.testid)).toEqual([
            'keyboard-shortcut-section-common',
            'keyboard-shortcut-section-navigation',
        ]);
        expect(Array.from(getByTestID('keyboard-shortcut-section-common').querySelectorAll<HTMLElement>(
            '[data-testid^="keyboard-shortcut-row-"]',
        )).map((element) => element.dataset.testid)).toEqual([
            'keyboard-shortcut-row-first-action',
            'keyboard-shortcut-row-second-action',
        ]);
        expect(Array.from(getByTestID('keyboard-shortcut-section-navigation').querySelectorAll<HTMLElement>(
            '[data-testid^="keyboard-shortcut-row-"]',
        )).map((element) => element.dataset.testid)).toEqual([
            'keyboard-shortcut-row-third-action',
        ]);
    });

    it('renders separate keycaps, visual alternatives, and hidden decorative content', () => {
        renderModal();

        const row = getByTestID('keyboard-shortcut-row-first-action');
        expect(Array.from(row.querySelectorAll<HTMLElement>(
            '[data-testid^="keyboard-shortcut-keycap-"]',
        )).map((element) => element.textContent)).toEqual(['⌘', 'K', 'Ctrl', 'K']);

        const separator = row.querySelector<HTMLElement>(
            '[data-testid="keyboard-shortcut-alternative-separator"]',
        );
        expect(separator?.textContent).toBe('/');
        expect(separator?.getAttribute('aria-hidden')).toBe('true');
        expect(Array.from(container.querySelectorAll<HTMLElement>('[data-icon]'))
            .every((icon) => icon.getAttribute('aria-hidden') === 'true')).toBe(true);
    });

    it('closes from the actual accessible close control', () => {
        const onClose = renderModal();

        act(() => getByTestID('keyboard-shortcuts-close').click());

        expect(onClose).toHaveBeenCalledOnce();
    });

    it('focuses close, contains forward and reverse Tab movement, and restores the opener', () => {
        renderModal();

        const panel = getByTestID('keyboard-shortcuts-dialog');
        const close = getByTestID('keyboard-shortcuts-close');
        const lastControl = document.createElement('button');
        lastControl.textContent = 'Last control';
        panel.append(lastControl);
        expect(document.activeElement).toBe(close);

        act(() => lastControl.focus());
        const forwardTab = new KeyboardEvent('keydown', {
            bubbles: true,
            cancelable: true,
            key: 'Tab',
        });
        act(() => lastControl.dispatchEvent(forwardTab));
        expect(forwardTab.defaultPrevented).toBe(true);
        expect(document.activeElement).toBe(close);
        expect(panel.contains(document.activeElement)).toBe(true);

        const reverseTab = new KeyboardEvent('keydown', {
            bubbles: true,
            cancelable: true,
            key: 'Tab',
            shiftKey: true,
        });
        act(() => close.dispatchEvent(reverseTab));
        expect(reverseTab.defaultPrevented).toBe(true);
        expect(document.activeElement).toBe(lastControl);
        expect(panel.contains(document.activeElement)).toBe(true);

        act(() => root?.unmount());
        root = undefined;
        expect(document.activeElement).toBe(opener);
    });
});
