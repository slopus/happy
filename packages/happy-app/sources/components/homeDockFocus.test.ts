import { beforeEach, describe, expect, it } from 'vitest';
import {
    registerHomeDockFocusListener,
    requestHomeDockFocus,
    useHomeDockFocusStore,
} from './homeDockFocus';

beforeEach(() => {
    useHomeDockFocusStore.setState({ requestId: 0, listeners: 0 });
});

describe('homeDockFocus', () => {
    it('reports no listener when the dock is not mounted', () => {
        expect(requestHomeDockFocus()).toBe(false);
        expect(useHomeDockFocusStore.getState().requestId).toBe(0);
    });

    it('bumps the request id once per request while a dock listens', () => {
        registerHomeDockFocusListener();

        expect(requestHomeDockFocus()).toBe(true);
        expect(requestHomeDockFocus()).toBe(true);
        expect(useHomeDockFocusStore.getState().requestId).toBe(2);
    });

    it('stops serving requests once every dock unmounts', () => {
        const release = registerHomeDockFocusListener();
        requestHomeDockFocus();
        release();

        expect(requestHomeDockFocus()).toBe(false);
        expect(useHomeDockFocusStore.getState().requestId).toBe(1);
    });

    it('keeps serving while one of several docks is still mounted', () => {
        const releaseFirst = registerHomeDockFocusListener();
        registerHomeDockFocusListener();
        releaseFirst();

        expect(requestHomeDockFocus()).toBe(true);
    });
});
