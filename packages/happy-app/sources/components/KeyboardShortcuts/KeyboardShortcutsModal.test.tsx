import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// react-test-renderer does not publish TypeScript declarations with the package.
// @ts-expect-error The test only needs the small create/unmount surface typed below.
import TestRenderer from 'react-test-renderer';

import type { ShortcutSection } from './shortcutCatalog';

const mocks = vi.hoisted(() => ({
    closeFocus: vi.fn(),
    keydownHandler: null as ((event: any) => void) | null,
    panelAddEventListener: vi.fn(),
    panelContains: vi.fn(),
    panelQuerySelectorAll: vi.fn(),
    panelRemoveEventListener: vi.fn(),
    restoreFocus: vi.fn(),
}));

vi.mock('react-native', async () => {
    const ReactModule = await import('react');
    const Pressable = ReactModule.forwardRef<any, any>((props, ref) => {
        ReactModule.useImperativeHandle(ref, () => ({ focus: mocks.closeFocus }), []);
        return ReactModule.createElement('Pressable', props, props.children);
    });
    const View = ReactModule.forwardRef<any, any>((props, ref) => {
        ReactModule.useImperativeHandle(ref, () => props.testID === 'keyboard-shortcuts-dialog'
            ? {
                addEventListener: mocks.panelAddEventListener,
                contains: mocks.panelContains,
                querySelectorAll: mocks.panelQuerySelectorAll,
                removeEventListener: mocks.panelRemoveEventListener,
            }
            : {}, [props.testID]);
        return ReactModule.createElement('View', props, props.children);
    });

    return {
        Platform: { OS: 'web', select: (values: any) => values.web ?? values.default },
        Pressable,
        ScrollView: 'ScrollView',
        Text: 'Text',
        View,
    };
});
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
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

describe('KeyboardShortcutsModal', () => {
    const originalConsoleError = console.error;
    const closeControl = { focus: mocks.closeFocus };
    let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
    let renderer: any;
    let documentStub: any;

    beforeEach(() => {
        vi.clearAllMocks();
        mocks.keydownHandler = null;
        documentStub = {
            activeElement: { focus: mocks.restoreFocus },
        };
        mocks.panelAddEventListener.mockImplementation((event: string, handler: (event: any) => void) => {
                if (event === 'keydown') mocks.keydownHandler = handler;
        });
        mocks.closeFocus.mockImplementation(() => {
            documentStub.activeElement = closeControl;
        });
        mocks.panelContains.mockImplementation((element: unknown) => element === closeControl);
        mocks.panelQuerySelectorAll.mockReturnValue([closeControl]);
        vi.stubGlobal('document', documentStub);
        (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
        consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation((...values: unknown[]) => {
            if (values[0] === 'react-test-renderer is deprecated. See https://react.dev/warnings/react-test-renderer') return;
            originalConsoleError(...values);
        });
    });

    afterEach(() => {
        if (renderer) {
            act(() => renderer.unmount());
        }
        renderer = undefined;
        consoleErrorSpy.mockRestore();
        vi.unstubAllGlobals();
    });

    function renderModal(onClose = vi.fn()) {
        act(() => {
            renderer = TestRenderer.create(
                <KeyboardShortcutsModal onClose={onClose} sections={sections} />,
            );
        });
        return onClose;
    }

    function findHostByTestID(testID: string, type = 'View') {
        return renderer.root.findAllByProps({ testID })
            .find((node: any) => node.type === type);
    }

    it('exposes localized dialog semantics with a fixed header and scrolling body', () => {
        renderModal();

        const panel = findHostByTestID('keyboard-shortcuts-dialog');
        expect(panel.props.accessibilityViewIsModal).toBe(true);
        expect(panel.props.accessibilityLabel).toBe('localized:keyboardShortcuts.title');
        expect(panel.props.role).toBe('dialog');
        expect(panel.props.style).toEqual(expect.objectContaining({
            borderRadius: 14,
            maxHeight: '76vh',
            maxWidth: 720,
            width: 'calc(100vw - 32px)',
        }));
        expect(panel?.children.map((child: any) => child.props.testID)).toEqual([
            'keyboard-shortcuts-header',
            'keyboard-shortcuts-scroll',
        ]);
        expect(renderer.root.findByProps({ testID: 'keyboard-shortcuts-title' }).children).toEqual([
            'localized:keyboardShortcuts.title',
        ]);
        expect(renderer.root.findByProps({ testID: 'keyboard-shortcuts-close' }).props.accessibilityLabel)
            .toBe('localized:keyboardShortcuts.close');
    });

    it('preserves section and row order', () => {
        renderModal();

        const scroll = findHostByTestID('keyboard-shortcuts-scroll', 'ScrollView');
        expect(scroll?.findAll((node: any) => node.type === 'View'
            && node.props.testID?.startsWith('keyboard-shortcut-section-'))
            .map((node: any) => node.props.testID)).toEqual([
            'keyboard-shortcut-section-common',
            'keyboard-shortcut-section-navigation',
        ]);
        expect(findHostByTestID('keyboard-shortcut-section-common')
            .findAll((node: any) => node.type === 'View'
                && node.props.testID?.startsWith('keyboard-shortcut-row-'))
            .map((node: any) => node.props.testID)).toEqual([
                'keyboard-shortcut-row-first-action',
                'keyboard-shortcut-row-second-action',
            ]);
        expect(findHostByTestID('keyboard-shortcut-section-navigation')
            .findAll((node: any) => node.type === 'View'
                && node.props.testID?.startsWith('keyboard-shortcut-row-'))
            .map((node: any) => node.props.testID)).toEqual([
                'keyboard-shortcut-row-third-action',
            ]);
    });

    it('renders every chord token in its own keycap and separates alternatives visually', () => {
        renderModal();

        const row = findHostByTestID('keyboard-shortcut-row-first-action');
        expect(row.findAll((node: any) => node.type === 'View'
            && node.props.testID?.startsWith('keyboard-shortcut-keycap-'))
            .map((node: any) => node.children[0]?.children[0])).toEqual(['⌘', 'K', 'Ctrl', 'K']);
        expect(row.findAllByProps({ testID: 'keyboard-shortcut-alternative-separator' }))
            .toHaveLength(1);
        expect(row.findByProps({ testID: 'keyboard-shortcut-alternative-separator' }).children)
            .toEqual(['/']);
    });

    it('closes from the accessible close control', () => {
        const onClose = renderModal();

        act(() => renderer.root.findByProps({ testID: 'keyboard-shortcuts-close' }).props.onPress());

        expect(onClose).toHaveBeenCalledOnce();
    });

    it('focuses close, traps Tab in the dialog, and restores prior focus on unmount', () => {
        renderModal();
        expect(mocks.closeFocus).toHaveBeenCalledOnce();

        documentStub.activeElement = documentStub.activeElement === closeControl
            ? { focus: vi.fn() }
            : documentStub.activeElement;
        const preventDefault = vi.fn();
        act(() => mocks.keydownHandler?.({ key: 'Tab', preventDefault, shiftKey: false }));
        expect(preventDefault).toHaveBeenCalledOnce();
        expect(mocks.closeFocus).toHaveBeenCalledTimes(2);

        act(() => renderer.unmount());
        renderer = undefined;
        expect(mocks.restoreFocus).toHaveBeenCalledOnce();
        expect(mocks.panelRemoveEventListener).toHaveBeenCalledWith(
            'keydown',
            expect.any(Function),
            true,
        );
    });
});
