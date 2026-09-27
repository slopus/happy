import { beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const mocks = vi.hoisted(() => ({
    getState: vi.fn(),
    subscribe: vi.fn(),
    play: vi.fn(async () => {}),
    sources: [] as string[],
}));

vi.mock('react-native', () => ({ Platform: { OS: 'web' } }));
vi.mock('./storage', () => ({ storage: { getState: mocks.getState, subscribe: mocks.subscribe } }));
vi.mock('@/utils/sessionUtils', () => ({ resolveSessionState: (session: { state: string }) => ({ state: session.state }) }));

import { playWebSessionEventSound, previewWebSound, startWebSoundAlerts, WEB_SOUND_CHOICES } from './webSoundAlerts';

const defaults = {
    enabled: true, volume: 0.3, scope: 'all', muteViewedSession: false,
    sounds: { completed: 'complete', failed: 'error', permission: 'approval', question: 'approval', started: 'off' },
};

beforeEach(() => {
    mocks.play.mockClear();
    mocks.sources.length = 0;
    mocks.getState.mockReturnValue({
        localSettings: { webSound: structuredClone(defaults) },
        currentViewingSessionId: null,
        settings: { sessionPinnedOrder: [] },
        sessions: {},
    });
    const values = new Map<string, string>();
    vi.stubGlobal('window', {});
    vi.stubGlobal('document', { visibilityState: 'hidden', hasFocus: () => false });
    vi.stubGlobal('navigator', {});
    vi.stubGlobal('localStorage', {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
    });
    vi.stubGlobal('Audio', class {
        volume = 1;
        constructor(public src: string) { mocks.sources.push(src); }
        pause() {}
        play = mocks.play;
    });
});

describe('web sound alerts', () => {
    it('uses sound URLs that the production assets route uploads', async () => {
        for (const choice of WEB_SOUND_CHOICES) {
            if (choice !== 'off') await previewWebSound(choice, 0.3);
        }
        expect(mocks.sources).toHaveLength(5);
        for (const src of mocks.sources) {
            expect(src).toMatch(/^\/assets\/sounds\/codeisland\/8bit_\w+\.wav$/);
            expect(existsSync(join(process.cwd(), 'public', src.slice(1)))).toBe(true);
        }
    });

    it('plays completion only for a real session transition, once per turn', () => {
        startWebSoundAlerts();
        const onChange = mocks.subscribe.mock.calls[0][0];
        const running = { state: 'running', updatedAt: 101, agentState: { turnStatus: { status: 'running', updatedAt: 102, turnId: 'one' } } };
        const completed = { state: 'completed', updatedAt: 101, agentState: { turnStatus: { status: 'completed', updatedAt: 103, turnId: 'one' } } };
        onChange({ isDataReady: true, sessions: { a: completed } }, { isDataReady: true, sessions: { a: running } });
        onChange({ isDataReady: true, sessions: { a: completed } }, { isDataReady: true, sessions: { a: running } });
        expect(mocks.play).toHaveBeenCalledTimes(1);
    });

    it('respects the current-session scope and separate permission and question events', () => {
        const state = mocks.getState();
        state.localSettings.webSound.scope = 'current';
        state.currentViewingSessionId = 'a';
        playWebSessionEventSound({ type: 'session-event', sessionId: 'b', kind: 'permission', title: '', body: '', timestamp: 201 });
        playWebSessionEventSound({ type: 'session-event', sessionId: 'a', kind: 'question', title: '', body: '', timestamp: 202 });
        expect(mocks.play).toHaveBeenCalledTimes(1);
    });

    it('limits alerts to pinned sessions and can mute the session in view', () => {
        const state = mocks.getState();
        state.localSettings.webSound.scope = 'pinned';
        state.settings.sessionPinnedOrder = ['a'];
        playWebSessionEventSound({ type: 'session-event', sessionId: 'b', kind: 'permission', title: '', body: '', timestamp: 251 });
        playWebSessionEventSound({ type: 'session-event', sessionId: 'a', kind: 'permission', title: '', body: '', timestamp: 252 });
        expect(mocks.play).toHaveBeenCalledTimes(1);

        state.localSettings.webSound.muteViewedSession = true;
        state.currentViewingSessionId = 'a';
        vi.stubGlobal('document', { visibilityState: 'visible', hasFocus: () => true });
        playWebSessionEventSound({ type: 'session-event', sessionId: 'a', kind: 'question', title: '', body: '', timestamp: 253 });
        expect(mocks.play).toHaveBeenCalledTimes(1);
    });

    it('does not ring when disabled or when previewing an off choice', async () => {
        mocks.getState().localSettings.webSound.enabled = false;
        playWebSessionEventSound({ type: 'session-event', sessionId: 'a', kind: 'permission', title: '', body: '', timestamp: 301 });
        expect(await previewWebSound('off', 0.3)).toBe(false);
        expect(mocks.play).not.toHaveBeenCalled();
    });

    it('does not treat a generic ready event as completion after a failed turn', () => {
        mocks.getState().sessions.a = { state: 'failed', agentState: { turnStatus: { status: 'failed', updatedAt: 350 } } };
        playWebSessionEventSound({ type: 'session-event', sessionId: 'a', kind: 'done', title: '', body: '', timestamp: 351 });
        expect(mocks.play).not.toHaveBeenCalled();
    });

    it('ignores generic done while a new turn still has the prior completed state cached', () => {
        const state = mocks.getState();
        state.sessions.a = { agentState: { turnStatus: { status: 'completed', updatedAt: 350 } } };
        playWebSessionEventSound({ type: 'session-event', sessionId: 'a', kind: 'done', title: '', body: '', timestamp: 361 });
        expect(mocks.play).not.toHaveBeenCalled();
    });

    it('lets another tab retry an event after this tab cannot play it', async () => {
        mocks.play.mockRejectedValueOnce(new Error('Autoplay blocked'));
        const event = { type: 'session-event' as const, sessionId: 'retry', kind: 'permission' as const, title: '', body: '', timestamp: 352 };
        playWebSessionEventSound(event);
        for (let i = 0; i < 4; i++) await Promise.resolve();
        playWebSessionEventSound(event);
        expect(mocks.play).toHaveBeenCalledTimes(2);
    });

    it('rings for a failed turn transition, never for initial history hydration', () => {
        startWebSoundAlerts();
        const onChange = mocks.subscribe.mock.calls[0][0];
        const base = { isDataReady: true, sessions: { a: { state: 'running', updatedAt: 401 } } };
        onChange({ isDataReady: true, sessions: { a: { state: 'failed', updatedAt: 402 } } }, base);
        onChange({ isDataReady: true, sessions: { b: { state: 'failed', updatedAt: 403 } } }, base);
        onChange({ isDataReady: true, sessions: { c: { state: 'failed', updatedAt: 404 } } }, { isDataReady: false, sessions: {} });
        expect(mocks.play).toHaveBeenCalledTimes(1);
    });

    it('rings again for a later failed turn when the session update time stays unchanged', () => {
        startWebSoundAlerts();
        const onChange = mocks.subscribe.mock.calls[0][0];
        const running = { state: 'running', updatedAt: 501, agentState: { turnStatus: { status: 'running', updatedAt: 502, turnId: 'one' } } };
        const firstFailure = { state: 'failed', updatedAt: 501, agentState: { turnStatus: { status: 'failed', updatedAt: 503, turnId: 'one' } } };
        const secondRunning = { state: 'running', updatedAt: 501, agentState: { turnStatus: { status: 'running', updatedAt: 504, turnId: 'two' } } };
        const secondFailure = { state: 'failed', updatedAt: 501, agentState: { turnStatus: { status: 'failed', updatedAt: 505, turnId: 'two' } } };
        onChange({ isDataReady: true, sessions: { later: firstFailure } }, { isDataReady: true, sessions: { later: running } });
        onChange({ isDataReady: true, sessions: { later: secondFailure } }, { isDataReady: true, sessions: { later: secondRunning } });
        expect(mocks.play).toHaveBeenCalledTimes(2);
    });

    it('rings again for a later completed turn when the session update time stays unchanged', () => {
        startWebSoundAlerts();
        const onChange = mocks.subscribe.mock.calls[0][0];
        const makeSession = (state: string, status: string, updatedAt: number, turnId: string) => ({
            state, updatedAt: 501, agentState: { turnStatus: { status, updatedAt, turnId } },
        });
        onChange(
            { isDataReady: true, sessions: { later: makeSession('completed', 'completed', 503, 'one') } },
            { isDataReady: true, sessions: { later: makeSession('running', 'running', 502, 'one') } },
        );
        onChange(
            { isDataReady: true, sessions: { later: makeSession('completed', 'completed', 505, 'two') } },
            { isDataReady: true, sessions: { later: makeSession('running', 'running', 504, 'two') } },
        );
        expect(mocks.play).toHaveBeenCalledTimes(2);
    });
});
