import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// react-test-renderer does not publish TypeScript declarations with the package.
// @ts-expect-error The test only needs the small create/unmount surface typed below.
import TestRenderer from 'react-test-renderer';

const mocks = vi.hoisted(() => ({
    createShortcutSections: vi.fn(() => [{ id: 'common', title: 'Common', rows: [] }]),
    desktopLayout: {
        enabled: true,
        rightPanelAvailable: true,
    },
    inTauri: true,
    keyboardOptions: undefined as { onOpenKeyboardShortcuts?: () => void } | undefined,
    modalShow: vi.fn(),
    modalState: { modals: [] as any[] },
    platform: { OS: 'web' },
    settings: {
        agentInputEnterToSend: false,
    },
}));

vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);

vi.mock('react-native', () => ({
    Platform: mocks.platform,
}));

vi.mock('@/modal', () => ({
    useModal: () => ({
        state: mocks.modalState,
        showModal: mocks.modalShow,
    }),
}));

vi.mock('@/hooks/useGlobalKeyboard', () => ({
    useGlobalKeyboard: (
        _handler: (() => void) | undefined,
        options?: { onOpenKeyboardShortcuts?: () => void },
    ) => {
        mocks.keyboardOptions = options;
    },
}));

vi.mock('@/sync/storage', () => ({
    useSetting: (name: keyof typeof mocks.settings) => mocks.settings[name],
}));

vi.mock('@/utils/isTauri', () => ({
    isTauri: () => mocks.inTauri,
}));

vi.mock('@/text', () => ({ t: (key: string) => `localized:${key}` }));

vi.mock('@/hooks/useDesktopWorkspaceLayout', () => ({
    useDesktopWorkspaceLayout: () => mocks.desktopLayout,
}));

vi.mock('./shortcutCatalog', () => ({
    createShortcutSections: mocks.createShortcutSections,
}));

vi.mock('./KeyboardShortcutsModal', () => ({
    KeyboardShortcutsModal: () => null,
}));

import { KeyboardShortcutsModal } from './KeyboardShortcutsModal';
import {
    KeyboardShortcutsProvider,
    useKeyboardShortcutsLauncher,
} from './KeyboardShortcutsProvider';

let latestLauncher: ReturnType<typeof useKeyboardShortcutsLauncher> = null;

function LauncherProbe() {
    latestLauncher = useKeyboardShortcutsLauncher();
    return null;
}

describe('KeyboardShortcutsProvider', () => {
    const originalConsoleError = console.error;
    let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
    let renderer: any;

    beforeEach(() => {
        vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
        mocks.createShortcutSections.mockClear();
        mocks.desktopLayout.enabled = true;
        mocks.desktopLayout.rightPanelAvailable = true;
        mocks.inTauri = true;
        mocks.keyboardOptions = undefined;
        mocks.modalShow.mockReset();
        mocks.modalState.modals = [];
        mocks.platform.OS = 'web';
        mocks.settings.agentInputEnterToSend = false;
        latestLauncher = null;
        vi.stubGlobal('navigator', {
            platform: 'MacIntel',
            userAgentData: { platform: 'macOS' },
        });
        consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation((...values: unknown[]) => {
            if (values[0] === 'react-test-renderer is deprecated. See https://react.dev/warnings/react-test-renderer') return;
            originalConsoleError(...values);
        });
    });

    afterEach(() => {
        if (renderer) {
            act(() => renderer.unmount());
            renderer = undefined;
        }
        consoleErrorSpy.mockRestore();
        vi.unstubAllGlobals();
    });

    function renderProvider() {
        act(() => {
            renderer = TestRenderer.create(
                <KeyboardShortcutsProvider>
                    <LauncherProbe />
                </KeyboardShortcutsProvider>,
            );
        });
    }

    function rerenderProvider() {
        act(() => {
            renderer.update(
                <KeyboardShortcutsProvider>
                    <LauncherProbe />
                </KeyboardShortcutsProvider>,
            );
        });
    }

    it('opens the reference with the current preferences and desktop capabilities', () => {
        renderProvider();

        act(() => {
            mocks.keyboardOptions?.onOpenKeyboardShortcuts?.();
        });

        expect(mocks.createShortcutSections).toHaveBeenCalledWith({
            enterToSend: false,
            inTauri: true,
            platform: 'macOS',
            rightPanelAvailable: true,
        });
        expect(mocks.modalShow).toHaveBeenCalledWith({
            type: 'custom',
            component: KeyboardShortcutsModal,
            accessibilityLabel: 'localized:keyboardShortcuts.title',
            props: {
                sections: [{ id: 'common', title: 'Common', rows: [] }],
            },
        });
    });

    it('allows one active shortcuts modal across the hotkey and launcher entry points', () => {
        renderProvider();

        act(() => {
            mocks.keyboardOptions?.onOpenKeyboardShortcuts?.();
            latestLauncher?.open();
        });

        expect(mocks.modalShow).toHaveBeenCalledOnce();

        mocks.modalState.modals = [{
            id: 'keyboard-shortcuts',
            type: 'custom',
            component: KeyboardShortcutsModal,
            props: { sections: [] },
        }];
        rerenderProvider();
        act(() => latestLauncher?.open());
        expect(mocks.modalShow).toHaveBeenCalledOnce();

        mocks.modalState.modals = [];
        rerenderProvider();
        act(() => latestLauncher?.open());

        expect(mocks.modalShow).toHaveBeenCalledTimes(2);
        expect(mocks.modalShow.mock.calls[1][0]).toMatchObject({
            type: 'custom',
            component: KeyboardShortcutsModal,
        });
    });

    it.each([
        { enabled: true, os: 'web', expected: true },
        { enabled: false, os: 'web', expected: false },
        { enabled: true, os: 'ios', expected: false },
    ])('reports availability=$expected for $os with desktop enabled=$enabled', ({ enabled, os, expected }) => {
        mocks.desktopLayout.enabled = enabled;
        mocks.platform.OS = os;
        renderProvider();

        expect(latestLauncher?.isAvailable).toBe(expected);
    });

    it('does not register the global shortcut while the desktop workspace is disabled', () => {
        mocks.desktopLayout.enabled = false;
        renderProvider();

        expect(mocks.keyboardOptions?.onOpenKeyboardShortcuts).toBeUndefined();
        act(() => mocks.keyboardOptions?.onOpenKeyboardShortcuts?.());
        expect(mocks.modalShow).not.toHaveBeenCalled();
    });

    it('does not open from the launcher while the desktop workspace is disabled', () => {
        mocks.desktopLayout.enabled = false;
        renderProvider();

        act(() => latestLauncher?.open());

        expect(mocks.modalShow).not.toHaveBeenCalled();
        expect(mocks.createShortcutSections).not.toHaveBeenCalled();
    });
});
