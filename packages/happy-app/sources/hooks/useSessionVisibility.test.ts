import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    state: { currentViewingSessionId: null as string | null, unread: new Set<string>() },
    setCurrentViewingSession: vi.fn(),
    onSessionVisible: vi.fn(),
    onSessionHidden: vi.fn(),
}));
vi.mock('@/sync/storage', () => ({ storage: { getState: () => ({
    ...mocks.state, setCurrentViewingSession: mocks.setCurrentViewingSession,
}) } }));
vi.mock('@/sync/sync', () => ({ sync: { onSessionVisible: mocks.onSessionVisible, onSessionHidden: mocks.onSessionHidden } }));

import { useSessionVisibility } from './useSessionVisibility';

type Props = { id: string; active: boolean; embedded?: boolean; realtimeStatus?: string };
function Harness({ id, active, embedded = false, realtimeStatus = 'disconnected' }: Props) {
    useSessionVisibility(id, active, embedded, realtimeStatus);
    return null;
}
let renderer: ReturnType<typeof create>;
function render(props: Props) {
    act(() => { renderer = create(React.createElement(Harness, props)); });
}
function update(props: Props) {
    act(() => renderer.update(React.createElement(Harness, props)));
}

beforeEach(() => {
    vi.clearAllMocks();
    mocks.state.currentViewingSessionId = null;
    mocks.state.unread = new Set(['a', 'b']);
    mocks.setCurrentViewingSession.mockImplementation((id: string | null) => {
        mocks.state.currentViewingSessionId = id;
        if (id) mocks.state.unread.delete(id);
    });
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => act(() => renderer.unmount()));

describe('session visibility lifecycle', () => {
    it('keeps a preloaded chat unread and inactive until it receives focus', () => {
        render({ id: 'a', active: false });
        expect(mocks.onSessionVisible).not.toHaveBeenCalled();
        expect(mocks.state.unread.has('a')).toBe(true);
        update({ id: 'a', active: true });
        expect(mocks.onSessionVisible).toHaveBeenCalledExactlyOnceWith('a');
        expect(mocks.state.currentViewingSessionId).toBe('a');
        expect(mocks.state.unread.has('a')).toBe(false);
        update({ id: 'a', active: false });
        expect(mocks.state.currentViewingSessionId).toBe('a');
    });

    it('does not activate an abandoned preload even when voice status changes', () => {
        render({ id: 'a', active: false });
        update({ id: 'a', active: false, realtimeStatus: 'connected' });
        expect(mocks.onSessionVisible).not.toHaveBeenCalled();
        expect(mocks.setCurrentViewingSession).not.toHaveBeenCalled();
    });

    it('cannot clear a newer screen ownership during cleanup', () => {
        render({ id: 'a', active: true });
        mocks.state.currentViewingSessionId = 'b';
        act(() => renderer.unmount());
        expect(mocks.state.currentViewingSessionId).toBe('b');
    });

    it('retains viewing ownership under sub-screens and releases it on unmount', () => {
        render({ id: 'a', active: true });
        update({ id: 'a', active: false });
        expect(mocks.state.currentViewingSessionId).toBe('a');
        act(() => renderer.unmount());
        expect(mocks.state.currentViewingSessionId).toBeNull();
    });

    it('tells sync a claimed chat is hidden on unmount, but not an embedded or never-focused one', () => {
        render({ id: 'a', active: true });
        act(() => renderer.unmount());
        expect(mocks.onSessionHidden).toHaveBeenCalledExactlyOnceWith('a');
        render({ id: 'b', active: true, embedded: true });
        act(() => renderer.unmount());
        render({ id: 'c', active: false });
        act(() => renderer.unmount());
        expect(mocks.onSessionHidden).toHaveBeenCalledTimes(1);
    });

    it('discarding a never-focused preload cannot clear an existing viewer', () => {
        mocks.state.currentViewingSessionId = 'a';
        render({ id: 'a', active: false });
        act(() => renderer.unmount());
        expect(mocks.state.currentViewingSessionId).toBe('a');
        expect(mocks.setCurrentViewingSession).not.toHaveBeenCalled();
    });

    it('refreshes on returning to an already mounted chat', () => {
        render({ id: 'a', active: true });
        update({ id: 'a', active: false });
        update({ id: 'a', active: true });
        expect(mocks.onSessionVisible).toHaveBeenCalledTimes(2);
    });

    it('lets an embedded chat sync without stealing primary ownership or clearing unread', () => {
        mocks.state.currentViewingSessionId = 'a';
        render({ id: 'b', active: true, embedded: true });
        expect(mocks.onSessionVisible).toHaveBeenCalledWith('b');
        expect(mocks.setCurrentViewingSession).not.toHaveBeenCalled();
        expect(mocks.state.unread.has('b')).toBe(true);
        update({ id: 'b', active: false, embedded: true });
        expect(mocks.state.currentViewingSessionId).toBe('a');
    });
});