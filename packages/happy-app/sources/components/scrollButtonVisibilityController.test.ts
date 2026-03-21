import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { createScrollButtonVisibilityController } from './scrollButtonVisibilityController';

describe('createScrollButtonVisibilityController', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('delays showing the button', () => {
        const onShow = vi.fn();
        const onHide = vi.fn();
        const controller = createScrollButtonVisibilityController({
            showDelayMs: 300,
            onShow,
            onHide,
        });

        controller.update(true);
        vi.advanceTimersByTime(299);
        expect(onShow).not.toHaveBeenCalled();

        vi.advanceTimersByTime(1);
        expect(onShow).toHaveBeenCalledTimes(1);
        expect(onHide).not.toHaveBeenCalled();
    });

    it('cancels pending show when user returns to bottom', () => {
        const onShow = vi.fn();
        const onHide = vi.fn();
        const controller = createScrollButtonVisibilityController({
            showDelayMs: 300,
            onShow,
            onHide,
        });

        controller.update(true);
        vi.advanceTimersByTime(150);
        controller.update(false);
        vi.advanceTimersByTime(300);

        expect(onShow).not.toHaveBeenCalled();
        expect(onHide).not.toHaveBeenCalled();
    });

    it('hides immediately when already visible', () => {
        const onShow = vi.fn();
        const onHide = vi.fn();
        const controller = createScrollButtonVisibilityController({
            showDelayMs: 300,
            onShow,
            onHide,
        });

        controller.update(true);
        vi.advanceTimersByTime(300);
        expect(onShow).toHaveBeenCalledTimes(1);

        controller.update(false);
        expect(onHide).toHaveBeenCalledTimes(1);
    });

    it('disposes pending timers', () => {
        const onShow = vi.fn();
        const onHide = vi.fn();
        const controller = createScrollButtonVisibilityController({
            showDelayMs: 300,
            onShow,
            onHide,
        });

        controller.update(true);
        controller.dispose();
        vi.advanceTimersByTime(300);

        expect(onShow).not.toHaveBeenCalled();
        expect(onHide).not.toHaveBeenCalled();
    });
});
