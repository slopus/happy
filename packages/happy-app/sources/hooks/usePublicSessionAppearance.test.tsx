import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// @ts-expect-error react-test-renderer has no declarations in this workspace.
import TestRenderer from 'react-test-renderer';

const runtime = vi.hoisted(() => ({
    getTheme: vi.fn(() => ({ colors: { groupped: { background: '#1A1512' } } })),
    setRootViewBackgroundColor: vi.fn(),
    setTheme: vi.fn(),
    themeName: 'caramelDark' as string | undefined,
}));

vi.mock('react-native', () => ({
    Platform: {
        OS: 'web',
        select: (values: Record<string, unknown>) => values.web ?? values.default,
    },
}));

vi.mock('react-native-unistyles', () => ({ UnistylesRuntime: runtime }));

import { usePublicSessionAppearance } from './usePublicSessionAppearance';
import type { ThemePackId } from '@/themePacks';

type MediaListener = (event: { matches: boolean }) => void;

function createMediaQuery(initialMatches: boolean) {
    const listeners = new Set<MediaListener>();
    return {
        addEventListener: vi.fn((_type: string, listener: MediaListener) => listeners.add(listener)),
        dispatch(matches: boolean) {
            this.matches = matches;
            for (const listener of listeners) listener({ matches });
        },
        listeners,
        matches: initialMatches,
        media: '(prefers-color-scheme: dark)',
        removeEventListener: vi.fn((_type: string, listener: MediaListener) => listeners.delete(listener)),
    };
}

function createLegacyMediaQuery(initialMatches: boolean) {
    const listeners = new Set<MediaListener>();
    return {
        addListener: vi.fn((listener: MediaListener) => listeners.add(listener)),
        dispatch(matches: boolean) {
            this.matches = matches;
            for (const listener of listeners) listener({ matches });
        },
        listeners,
        matches: initialMatches,
        media: '(prefers-color-scheme: dark)',
        removeListener: vi.fn((listener: MediaListener) => listeners.delete(listener)),
    };
}

function createLocalStorage(initial: Record<string, string> = {}) {
    const values = new Map(Object.entries(initial));
    return {
        clear: () => values.clear(),
        getItem: vi.fn((key: string) => values.get(key) ?? null),
        key: (index: number) => [...values.keys()][index] ?? null,
        get length() { return values.size; },
        removeItem: (key: string) => values.delete(key),
        setItem: vi.fn((key: string, value: string) => values.set(key, value)),
    };
}

function renderAppearance(themePack: ThemePackId) {
    let latest: ReturnType<typeof usePublicSessionAppearance> | null = null;
    const renderHistory: Array<{ isReady: boolean; pack: ThemePackId }> = [];
    function Harness(props: { pack: ThemePackId }) {
        latest = usePublicSessionAppearance(props.pack);
        renderHistory.push({ isReady: latest.isReady, pack: props.pack });
        return null;
    }
    let renderer: any;
    act(() => {
        renderer = TestRenderer.create(<Harness pack={themePack} />);
    });
    return {
        current: () => latest as ReturnType<typeof usePublicSessionAppearance>,
        renderHistory,
        rerender: (pack: ThemePackId) => act(() => renderer.update(<Harness pack={pack} />)),
        unmount: () => act(() => renderer.unmount()),
    };
}

describe('usePublicSessionAppearance', () => {
    let mediaQuery: ReturnType<typeof createMediaQuery>;

    beforeEach(() => {
        vi.clearAllMocks();
        runtime.themeName = 'caramelDark';
        runtime.getTheme.mockReturnValue({ colors: { groupped: { background: '#1A1512' } } });
        mediaQuery = createMediaQuery(false);
        vi.stubGlobal('window', {
            localStorage: createLocalStorage(),
            matchMedia: vi.fn(() => mediaQuery),
        });
        (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    });

    afterEach(() => {
        delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
        vi.unstubAllGlobals();
    });

    it('defaults to system mode and applies the owner-fixed pack with its semantic background', () => {
        const hook = renderAppearance('gingham');

        expect(hook.renderHistory[0]).toEqual({ isReady: false, pack: 'gingham' });
        expect(hook.current().isReady).toBe(true);
        expect(hook.current().mode).toBe('system');
        expect(runtime.setTheme).toHaveBeenCalledWith('ginghamLight');
        expect(runtime.setRootViewBackgroundColor).toHaveBeenCalledWith('#F4F7FA');
        expect(window.localStorage.setItem).toHaveBeenCalledWith(
            'paws.public-share.appearance-mode',
            'system',
        );

        hook.unmount();
    });

    it('gates an owner-pack transition until the exact new pack theme is applied', () => {
        const hook = renderAppearance('gingham');
        const transitionStart = hook.renderHistory.length;

        hook.rerender('grape');

        const transition = hook.renderHistory.slice(transitionStart);
        expect(transition[0]).toEqual({ isReady: false, pack: 'grape' });
        expect(transition.at(-1)).toEqual({ isReady: true, pack: 'grape' });
        expect(runtime.setTheme).toHaveBeenLastCalledWith('grapeLight');
        hook.unmount();
    });

    it('persists explicit light and dark choices and reuses them across public IDs without changing the pack', () => {
        vi.stubGlobal('window', {
            localStorage: createLocalStorage({ 'paws.public-share.appearance-mode': 'dark' }),
            matchMedia: vi.fn(() => mediaQuery),
        });
        const firstShare = renderAppearance('sakura');

        expect(firstShare.current().isReady).toBe(true);
        expect(firstShare.current().mode).toBe('dark');
        expect(runtime.setTheme.mock.calls.map(([themeName]) => themeName)).toEqual(['sakuraDark']);

        act(() => firstShare.current().setMode('light'));
        expect(runtime.setTheme).toHaveBeenLastCalledWith('sakuraLight');
        expect(window.localStorage.setItem).toHaveBeenLastCalledWith(
            'paws.public-share.appearance-mode',
            'light',
        );
        firstShare.rerender('grape');
        expect(runtime.setTheme).toHaveBeenLastCalledWith('grapeLight');

        firstShare.unmount();
        const secondShare = renderAppearance('terminal');
        expect(secondShare.current().mode).toBe('light');
        expect(runtime.setTheme).toHaveBeenLastCalledWith('terminalLight');
        secondShare.unmount();
    });

    it('follows media-query changes only while system mode is selected', () => {
        const hook = renderAppearance('acorn');

        expect(mediaQuery.listeners.size).toBe(1);
        act(() => hook.current().setMode('light'));
        expect(mediaQuery.listeners.size).toBe(0);
        expect(runtime.setTheme).toHaveBeenLastCalledWith('acornLight');
        act(() => mediaQuery.dispatch(true));
        expect(runtime.setTheme).toHaveBeenLastCalledWith('acornLight');

        runtime.setTheme.mockClear();
        act(() => hook.current().setMode('system'));
        expect(mediaQuery.listeners.size).toBe(1);
        expect(runtime.setTheme.mock.calls.map(([themeName]) => themeName)).toEqual(['acornDark']);
        act(() => mediaQuery.dispatch(false));
        expect(runtime.setTheme).toHaveBeenLastCalledWith('acornLight');

        hook.unmount();
        expect(mediaQuery.listeners.size).toBe(0);
    });

    it('recovers invalid storage safely and restores the previous global theme on unmount', () => {
        vi.stubGlobal('window', {
            localStorage: createLocalStorage({ 'paws.public-share.appearance-mode': 'sepia' }),
            matchMedia: vi.fn(() => mediaQuery),
        });
        const hook = renderAppearance('grape');

        expect(hook.current().mode).toBe('system');
        expect(runtime.setTheme).toHaveBeenLastCalledWith('grapeLight');
        hook.unmount();
        expect(runtime.setTheme).toHaveBeenLastCalledWith('caramelDark');
        expect(runtime.setRootViewBackgroundColor).toHaveBeenLastCalledWith('#1A1512');
    });

    it('supports legacy media-query listeners and removes them on explicit selection', () => {
        const legacyMediaQuery = createLegacyMediaQuery(true);
        vi.stubGlobal('window', {
            localStorage: createLocalStorage(),
            matchMedia: vi.fn(() => legacyMediaQuery),
        });

        const hook = renderAppearance('gingham');
        expect(hook.current().isReady).toBe(true);
        expect(runtime.setTheme).toHaveBeenLastCalledWith('ginghamDark');
        expect(legacyMediaQuery.addListener).toHaveBeenCalledOnce();
        expect(legacyMediaQuery.listeners.size).toBe(1);

        act(() => hook.current().setMode('light'));
        expect(legacyMediaQuery.removeListener).toHaveBeenCalledOnce();
        expect(legacyMediaQuery.listeners.size).toBe(0);

        hook.unmount();
    });
});
