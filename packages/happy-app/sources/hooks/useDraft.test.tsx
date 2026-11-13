import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error react-test-renderer does not publish declarations.
import TestRenderer from 'react-test-renderer';
import { useDraft } from './useDraft';

const state = vi.hoisted(() => ({
    focused: true,
    sessions: {} as Record<string, { draft: string | null }>,
    writes: [] as Array<[string, string | null]>,
    listeners: new Set<(state: string) => void>(),
}));
vi.mock('@react-navigation/native', () => ({ useIsFocused: () => state.focused }));
vi.mock('react-native', () => ({ AppState: { addEventListener: (_: string, fn: (state: string) => void) => {
    state.listeners.add(fn);
    return { remove: () => state.listeners.delete(fn) };
} } }));
vi.mock('@/sync/storage', () => ({ storage: { getState: () => ({
    sessions: state.sessions,
    updateSessionDraft: (id: string, draft: string | null) => {
        state.writes.push([id, draft]);
        state.sessions[id] = { draft };
    },
}) } }));

describe('useDraft lifecycle', () => {
    let renderer: any;
    let controls: ReturnType<typeof useDraft>;
    const onChange = vi.fn();
    function Composer({ id = 'a', value }: { id?: string; value: string }) {
        controls = useDraft(id, value, onChange);
        return null;
    }
    const render = (value: string, id = 'a') => act(() => {
        const element = <Composer id={id} value={value} />;
        if (renderer) renderer.update(element);
        else renderer = TestRenderer.create(element);
    });
    beforeEach(() => {
        (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
        vi.useFakeTimers();
        state.focused = true;
        state.sessions = { a: { draft: 'start' }, b: { draft: 'other' } };
        state.writes = [];
        state.listeners.clear();
        onChange.mockClear();
    });
    afterEach(() => {
        act(() => renderer?.unmount());
        renderer = undefined;
        vi.useRealTimers();
    });
    it('debounces continuing edits for two seconds without saving previous text on rerender', () => {
        render('start');
        render('first');
        act(() => vi.advanceTimersByTime(1000));
        render('latest');
        expect(state.writes).toEqual([]);
        act(() => vi.advanceTimersByTime(1999));
        expect(state.writes).toEqual([]);
        act(() => vi.advanceTimersByTime(1));
        expect(state.writes).toEqual([['a', 'latest']]);
    });
    it.each(['blur', 'background', 'inactive', 'unmount'])('flushes latest text on %s', (event) => {
        render('start');
        render('latest');
        act(() => {
            if (event === 'blur') { state.focused = false; render('latest'); }
            else if (event === 'unmount') { renderer.unmount(); renderer = undefined; }
            else state.listeners.forEach(fn => fn(event));
        });
        expect(state.writes).toEqual([['a', 'latest']]);
    });
    it('flushes the old session on switch without writing its text to the new session', () => {
        render('start');
        render('unsaved a');
        render('other', 'b');
        act(() => vi.advanceTimersByTime(2000));
        expect(state.writes).toEqual([['a', 'unsaved a']]);
    });
    it('clearing a sent draft cancels pending saves and prevents unmount resurrection', () => {
        render('start');
        render('sending');
        act(() => controls.clearDraft());
        act(() => vi.advanceTimersByTime(2000));
        act(() => { renderer.unmount(); renderer = undefined; });
        expect(state.sessions.a.draft).toBeNull();
        expect(state.writes).toEqual([['a', null]]);
    });
    it('saves empty/nonempty transitions immediately and accepts editing after clear', () => {
        state.sessions.a.draft = null;
        render('');
        render('new');
        expect(state.writes).toEqual([['a', 'new']]);
        act(() => controls.clearDraft());
        render('');
        render('next');
        expect(state.sessions.a.draft).toBe('next');
    });

    it('hydrates a saved draft without overwriting it with the initial empty render', () => {
        render('');
        expect(onChange).toHaveBeenCalledWith('start');
        render('start');
        act(() => vi.advanceTimersByTime(2000));
        expect(state.writes).toEqual([]);
    });

    it('flushes input received before its deferred render commits on unmount', () => {
        render('start');
        controls.updateDraft('newest characters');
        act(() => { renderer.unmount(); renderer = undefined; });
        expect(state.writes).toEqual([['a', 'newest characters']]);
    });

    it('debounces from the input event and ignores a stale deferred mirror render', () => {
        render('start');
        controls.updateDraft('first');
        act(() => vi.advanceTimersByTime(1000));
        controls.updateDraft('latest');
        render('first');
        act(() => vi.advanceTimersByTime(1999));
        expect(state.writes).toEqual([]);
        act(() => vi.advanceTimersByTime(1));
        expect(state.writes).toEqual([['a', 'latest']]);
    });

    it('clears synchronously notified input without resurrecting an older deferred render', () => {
        render('start');
        controls.updateDraft('first');
        controls.updateDraft('sending');
        controls.clearDraft();
        render('first');
        act(() => vi.advanceTimersByTime(2000));
        act(() => { renderer.unmount(); renderer = undefined; });
        expect(state.writes).toEqual([['a', null]]);
    });

    it('keeps pending input notifications owned by the previous session on navigation', () => {
        render('start');
        controls.updateDraft('pending a');
        render('other', 'b');
        act(() => vi.advanceTimersByTime(2000));
        expect(state.writes).toEqual([['a', 'pending a']]);
    });

    it.each(['new text from the workspace', null])('restores the current shared draft when a retained page regains focus: %s', latest => {
        render('start');
        state.focused = false; render('start');
        state.sessions.a.draft = latest;
        onChange.mockClear();
        state.focused = true; render('start');
        expect(onChange).toHaveBeenCalledExactlyOnceWith(latest ?? '');
        render(latest ?? '');
        act(() => vi.advanceTimersByTime(2000));
        expect(state.sessions.a.draft).toBe(latest);
        expect(state.writes).toEqual([]);
    });

    it('does not overwrite newer pending input with shared storage on focus restoration', () => {
        render('start');
        const notify = controls.updateDraft;
        state.focused = false; render('start');
        notify('local input before focus restoration');
        state.sessions.a.draft = 'other display';
        state.focused = true; render('start');
        expect(onChange).not.toHaveBeenCalled();
        act(() => vi.advanceTimersByTime(2000));
        expect(state.sessions.a.draft).toBe('local input before focus restoration');
    });

    it('flushes the live textarea and cancels its old debounce before another display edits the draft', () => {
        render('start');
        controls.updateDraft('partial mirror');
        controls.flushDraft('latest textarea text');
        expect(state.sessions.a.draft).toBe('latest textarea text');
        state.sessions.a.draft = 'edited in workspace';
        act(() => vi.advanceTimersByTime(2000));
        expect(state.sessions.a.draft).toBe('edited in workspace');
    });

    it('restores a new shared draft after this retained composer previously sent and cleared its own text', () => {
        render('start');
        controls.clearDraft(); render('');
        state.focused = false; render('');
        state.sessions.a.draft = 'new workspace draft';
        state.focused = true; render('');
        expect(onChange).toHaveBeenLastCalledWith('new workspace draft');
    });
});
