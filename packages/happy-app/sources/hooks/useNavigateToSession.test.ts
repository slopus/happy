import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    platform: { OS: 'ios' },
    mac: false,
    state: { sessions: {} as Record<string, { id: string }>, currentViewingSessionId: null as string | null },
    router: { push: vi.fn(), replace: vi.fn(), dismissTo: vi.fn(), prefetch: vi.fn() },
    preloadSession: vi.fn(),
    trackSessionSwitched: vi.fn(),
    perfMark: vi.fn(),
}));

vi.mock('react-native', () => ({ Platform: mocks.platform }));
vi.mock('@/utils/platform', () => ({ isRunningOnMac: () => mocks.mac }));
vi.mock('expo-router', () => ({ useRouter: () => mocks.router }));
vi.mock('@/sync/storage', () => ({ storage: { getState: () => mocks.state } }));
vi.mock('@/sync/sync', () => ({ sync: { preloadSession: mocks.preloadSession } }));
vi.mock('@/track', () => ({ trackSessionSwitched: mocks.trackSessionSwitched }));
vi.mock('@/utils/perfLog', () => ({ perfMark: mocks.perfMark }));

import { replaceToSession, singularSessionRoute, useSessionPressHandlers } from './useNavigateToSession';

let renderer: ReturnType<typeof create>;
let handlers: ReturnType<typeof useSessionPressHandlers>;
function Harness({ id }: { id: string }) {
    handlers = useSessionPressHandlers(id);
    return null;
}

beforeEach(() => {
    vi.clearAllMocks();
    mocks.router.prefetch.mockReset();
    mocks.router.replace.mockReset();
    mocks.router.dismissTo.mockReset();
    mocks.platform.OS = 'ios';
    mocks.mac = false;
    mocks.state.sessions = { a: { id: 'a' }, 'a/b?c': { id: 'a/b?c' } };
    mocks.state.currentViewingSessionId = null;
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    act(() => { renderer = create(React.createElement(Harness, { id: 'a' })); });
});
afterEach(() => act(() => renderer.unmount()));

describe('session row press contract', () => {
    it('prepares on touch-down without navigating or tracking a switch', () => {
        handlers.onPressIn();
        expect(mocks.preloadSession).toHaveBeenCalledWith('a');
        expect(mocks.router.prefetch).toHaveBeenCalledWith('/session/a');
        expect(mocks.router.push).not.toHaveBeenCalled();
        expect(mocks.trackSessionSwitched).not.toHaveBeenCalled();
        expect(mocks.perfMark).not.toHaveBeenCalledWith('session-open:a');
        expect(handlers).not.toHaveProperty('onPressOut');
    });

    it('navigates immediately on completed press without waiting for preparation', () => {
        mocks.preloadSession.mockReturnValue(new Promise(() => {}));
        handlers.onPressIn();
        handlers.onPress();
        expect(mocks.router.push).toHaveBeenCalledExactlyOnceWith('/session/a');
        expect(mocks.trackSessionSwitched).toHaveBeenCalledExactlyOnceWith();
        expect(mocks.perfMark).toHaveBeenCalledWith('session-open:a');
    });

    it('supports activation without a prior touch-down', () => {
        handlers.onPress();
        expect(mocks.router.push).toHaveBeenCalledWith('/session/a');
        expect(mocks.preloadSession).not.toHaveBeenCalled();
    });

    it('can still navigate if the optional router prefetch fails', () => {
        mocks.router.prefetch.mockImplementationOnce(() => { throw new Error('not ready'); });
        const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
        expect(() => handlers.onPressIn()).not.toThrow();
        handlers.onPress();
        expect(mocks.router.push).toHaveBeenCalledWith('/session/a');
        warning.mockRestore();
    });

    it('uses the same encoded destination for preparation and navigation', () => {
        act(() => renderer.update(React.createElement(Harness, { id: 'a/b?c' })));
        handlers.onPressIn();
        handlers.onPress();
        expect(mocks.router.prefetch).toHaveBeenCalledWith('/session/a%2Fb%3Fc');
        expect(mocks.router.push).toHaveBeenCalledWith('/session/a%2Fb%3Fc');
    });

    it('keeps one session route in the web stack while preserving native pushes', () => {
        mocks.platform.OS = 'web';
        handlers.onPress();
        expect(mocks.router.push).toHaveBeenCalledWith('/session/a', {
            dangerouslySingular: singularSessionRoute,
        });
        expect(singularSessionRoute('session/[id]')).toBe('session/[id]');
    });

    it('uses web pop-to replacement while preserving native replace', () => {
        mocks.platform.OS = 'web';
        replaceToSession(mocks.router as any, 'a/b?c');
        expect(mocks.router.dismissTo).toHaveBeenCalledWith('/session/a%2Fb%3Fc');
        expect(mocks.router.replace).not.toHaveBeenCalled();

        mocks.platform.OS = 'ios';
        replaceToSession(mocks.router as any, 'a');
        expect(mocks.router.replace).toHaveBeenLastCalledWith('/session/a');
    });

    it.each(['web', 'mac', 'missing', 'current'])('skips unnecessary preload: %s', (reason) => {
        if (reason === 'web') mocks.platform.OS = 'web';
        if (reason === 'mac') mocks.mac = true;
        if (reason === 'missing') mocks.state.sessions = {};
        if (reason === 'current') mocks.state.currentViewingSessionId = 'a';
        handlers.onPressIn();
        expect(mocks.preloadSession).not.toHaveBeenCalled();
        expect(mocks.router.prefetch).not.toHaveBeenCalled();
        handlers.onPress();
        if (reason === 'web') {
            expect(mocks.router.push).toHaveBeenCalledWith('/session/a', {
                dangerouslySingular: singularSessionRoute,
            });
        } else {
            expect(mocks.router.push).toHaveBeenCalledWith('/session/a');
        }
    });
});