import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error react-test-renderer ships without declarations.
import TestRenderer from 'react-test-renderer';
import { useDesktopSidebarReveal } from './useDesktopSidebarReveal';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('desktop sidebar reveal', () => {
    let renderer: any;
    let current: ReturnType<typeof useDesktopSidebarReveal>;
    function Harness({ enabled = true, resizing = false }) {
        current = useDesktopSidebarReveal(enabled, resizing);
        return null;
    }
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { act(() => renderer?.unmount()); vi.useRealTimers(); });
    it('starts collapsed, reveals on hover and cancels closing when the pointer returns', () => {
        act(() => { renderer = TestRenderer.create(<Harness />); });
        expect(current.visible).toBe(false);
        act(() => current.setHovered(true));
        expect(current.visible).toBe(true);
        act(() => current.setHovered(false));
        act(() => vi.advanceTimersByTime(100));
        expect(current.visible).toBe(true);
        act(() => current.setHovered(true));
        act(() => vi.advanceTimersByTime(300));
        expect(current.visible).toBe(true);
        act(() => current.setHovered(false));
        act(() => vi.advanceTimersByTime(220));
        expect(current.visible).toBe(false);
    });
    it('keeps keyboard focus and resizing usable after the pointer leaves', () => {
        act(() => { renderer = TestRenderer.create(<Harness />); });
        act(() => current.setFocused(true));
        act(() => vi.advanceTimersByTime(300));
        expect(current.visible).toBe(true);
        act(() => { current.setFocused(false); renderer.update(<Harness resizing />); });
        act(() => vi.advanceTimersByTime(300));
        expect(current.visible).toBe(true);
        act(() => renderer.update(<Harness />));
        act(() => vi.advanceTimersByTime(220));
        expect(current.visible).toBe(false);
    });
    it('keeps explicit opening after exiting Zen and cancels a pending hover close', () => {
        act(() => { renderer = TestRenderer.create(<Harness enabled={false} />); });
        act(() => { current.toggle(); renderer.update(<Harness />); });
        act(() => vi.advanceTimersByTime(300));
        expect(current.visible).toBe(true);
        act(() => current.setHovered(true));
        act(() => current.setHovered(false));
        act(() => { current.toggle(); current.toggle(); });
        act(() => vi.advanceTimersByTime(300));
        expect(current.visible).toBe(true);
    });
    it('disables reveal in Zen/mobile and cleans up pending closes', () => {
        act(() => { renderer = TestRenderer.create(<Harness />); });
        act(() => current.setHovered(true));
        act(() => renderer.update(<Harness enabled={false} />));
        expect(current.visible).toBe(false);
        act(() => vi.advanceTimersByTime(300));
        expect(current.visible).toBe(false);
    });
});
