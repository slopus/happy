import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebTranscriptScrollCoordinator } from './webTranscriptScrollCoordinator';

describe('Web transcript scroll ownership', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());
    const setup = () => {
        const port = { scrollToOffset: vi.fn(), scrollToIndex: vi.fn(), scrollToEnd: vi.fn() };
        const coordinator = new WebTranscriptScrollCoordinator(() => port);
        return { coordinator, port };
    };
    it('compensates once and does not let the resulting scroll load another page', () => {
        const { coordinator: c, port } = setup();
        c.userIntent('older');
        const id = c.beginHistory('page-1', 'older')!;
        expect(c.beginHistory('page-2', 'older')).toBeNull();
        expect(c.compensate(id, 1400)).toBe(true);
        expect(c.compensate(id, 2400)).toBe(false);
        c.finishHistory(id);
        c.activity();
        expect(c.beginHistory('page-2', 'older')).toBeNull();
        expect(port.scrollToOffset).toHaveBeenCalledTimes(1);
        c.dispose();
    });
    it('ignores old compensation after reversal, session reset or jump', () => {
        const { coordinator: c, port } = setup();
        for (const cancel of [() => c.userIntent('newer'), () => c.reset(), () => c.jump()]) {
            c.userIntent('older');
            const id = c.beginHistory('page', 'older')!;
            cancel();
            expect(c.compensate(id, 5000)).toBe(false);
        }
        expect(port.scrollToOffset).not.toHaveBeenCalled();
        c.dispose();
    });
    it('captures only after idle, without allocating a timer per scroll event', () => {
        const { coordinator: c } = setup();
        c.onSettled = vi.fn();
        c.userIntent('older');
        for (let i = 0; i < 20; i++) { vi.advanceTimersByTime(16); c.activity(); }
        expect(vi.getTimerCount()).toBe(1);
        expect(c.onSettled).not.toHaveBeenCalled();
        vi.advanceTimersByTime(250);
        expect(c.onSettled).toHaveBeenCalledTimes(1);
        c.dispose();
    });
    it('waits for the target row and lets user input cancel a pending jump', () => {
        const { coordinator: c } = setup();
        const align = vi.fn();
        c.jump('target', align);
        c.rowMounted('other');
        expect(align).not.toHaveBeenCalled();
        c.rowMounted('target'); c.rowMounted('target');
        expect(align).toHaveBeenCalledTimes(1);
        c.jump('target', align);
        c.userIntent('older'); c.rowMounted('target');
        expect(align).toHaveBeenCalledTimes(1);
        c.dispose();
    });
    it('does not save a reading position while history is loading', () => {
        const { coordinator: c } = setup();
        c.onSettled = vi.fn();
        c.userIntent('older');
        const id = c.beginHistory('page', 'older')!;
        vi.advanceTimersByTime(300);
        expect(c.canCapture()).toBe(false);
        expect(c.onSettled).not.toHaveBeenCalled();
        c.finishHistory(id); vi.advanceTimersByTime(250);
        expect(c.onSettled).toHaveBeenCalledTimes(1);
        c.dispose();
    });
    it('releases a completed no-progress fetch and ignores disposed asynchronous writes', () => {
        const { coordinator: c, port } = setup();
        c.userIntent('older'); c.beginHistory('unchanged', 'older');
        c.observeLoading(true); c.observeLoading(false);
        expect(c.history).toBeNull();
        c.dispose();
        c.driver.scrollToEnd({ animated: false });
        expect(port.scrollToEnd).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
        c.activate(); // React StrictMode's effect setup after cleanup.
        c.driver.scrollToEnd({ animated: false });
        expect(port.scrollToEnd).toHaveBeenCalledTimes(1);
        c.dispose();
    });
});
