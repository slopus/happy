import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { storage } from '@/sync/storage';
import { sync } from '@/sync/sync';
import { useSessionResultSyncing } from './useSessionResultSyncing';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import TestRenderer from 'react-test-renderer';

// Keep the real Zustand subscription behavior, replacing application startup
// and persistence with a controlled message-progress snapshot.
vi.mock('@/sync/storage', async () => {
    const { create } = await import('zustand');
    return { storage: create(() => ({ sessions: {}, sessionMessages: {} })) };
});
vi.mock('@/sync/sync', () => ({ sync: { ensureMessagesLoaded: vi.fn().mockResolvedValue(undefined) } }));

const originalConsoleError = console.error;
const renderers: Array<{ unmount(): void }> = [];
let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

function setProgress({
    seq = 12,
    latestAppliedSeq = 10,
    isLoaded = true,
    isAtLatest = true,
}: {
    seq?: number;
    latestAppliedSeq?: number | null;
    isLoaded?: boolean;
    isAtLatest?: boolean;
} = {}) {
    storage.setState({
        sessions: { current: { id: 'current', seq } },
        sessionMessages: { current: { isLoaded, isAtLatest, latestAppliedSeq: latestAppliedSeq ?? undefined } },
    } as unknown as Parameters<typeof storage.setState>[0]);
}

function renderProgress(recover = false) {
    const result = { current: false, renders: 0 };
    function Harness() {
        result.current = useSessionResultSyncing('current', recover);
        result.renders += 1;
        return null;
    }
    act(() => { renderers.push(TestRenderer.create(<Harness />)); });
    return result;
}

beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation((...values: unknown[]) => {
        if (values[0] === 'react-test-renderer is deprecated. See https://react.dev/warnings/react-test-renderer') return;
        originalConsoleError(...values);
    });
    storage.setState({ sessions: {}, sessionMessages: {} });
});

afterEach(() => {
    act(() => { renderers.splice(0).forEach((renderer) => renderer.unmount()); });
    vi.useRealTimers();
    vi.mocked(sync.ensureMessagesLoaded).mockClear();
    consoleErrorSpy.mockRestore();
});

describe('useSessionResultSyncing', () => {
    it('retries a visible result gap until the missing messages are applied', async () => {
        vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
        setProgress({ seq: 86, latestAppliedSeq: 75 });
        renderProgress(true);
        expect(sync.ensureMessagesLoaded).toHaveBeenCalledTimes(1);
        await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
        expect(sync.ensureMessagesLoaded).toHaveBeenCalledTimes(3);

        act(() => setProgress({ seq: 86, latestAppliedSeq: 86 }));
        await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
        expect(sync.ensureMessagesLoaded).toHaveBeenCalledTimes(3);
    });

    it('does not recover an older history window', async () => {
        vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
        setProgress({ isAtLatest: false });
        renderProgress(true);
        await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
        expect(sync.ensureMessagesLoaded).not.toHaveBeenCalled();
    });

    it('updates when received messages enter the list and when new results arrive', () => {
        setProgress();
        const result = renderProgress();
        expect(result.current).toBe(true);
        act(() => setProgress({ latestAppliedSeq: 12 }));
        expect(result.current).toBe(false);
        act(() => setProgress({ seq: 13, latestAppliedSeq: 12 }));
        expect(result.current).toBe(true);
    });

    it.each([
        { name: 'unloaded cache', isLoaded: false },
        { name: 'older-history window', isAtLatest: false },
        { name: 'unknown progress baseline', latestAppliedSeq: null },
        { name: 'caught-up cache', latestAppliedSeq: 12 },
        { name: 'list ahead of stale session metadata', latestAppliedSeq: 13 },
    ])('does not report pending results for $name', (progress) => {
        setProgress(progress);
        expect(renderProgress().current).toBe(false);
    });

    it('does not report pending results for an absent session or cache', () => {
        expect(renderProgress().current).toBe(false);
        act(() => storage.setState({ sessions: { current: { id: 'current', seq: 12 } } } as unknown as Parameters<typeof storage.setState>[0]));
        expect(renderProgress().current).toBe(false);
    });

    it('does not rerender when unrelated session progress changes', () => {
        setProgress();
        const result = renderProgress();
        const initialRenders = result.renders;
        act(() => storage.setState((state) => ({
            sessions: { ...state.sessions, other: { ...state.sessions.current, id: 'other', seq: 100 } },
            sessionMessages: { ...state.sessionMessages, other: { ...state.sessionMessages.current, latestAppliedSeq: 99 } },
        })));
        expect(result.current).toBe(true);
        expect(result.renders).toBe(initialRenders);
    });
});
