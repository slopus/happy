import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSheetMessageInteractionManager } from './sheetMessageInteraction';

describe('createSheetMessageInteractionManager', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-03-19T00:00:00Z'));
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('fires tap callback for a quick mouse click', () => {
        const onTap = vi.fn();
        const onLongPress = vi.fn();
        const manager = createSheetMessageInteractionManager();

        manager.start({ nativeEvent: { pageX: 120, pageY: 240 } }, { onTap, onLongPress });
        vi.advanceTimersByTime(100);
        manager.end({ nativeEvent: { pageX: 120, pageY: 240 } });

        expect(onTap).toHaveBeenCalledTimes(1);
        expect(onLongPress).not.toHaveBeenCalled();
    });

    it('fires long press callback with the press coordinates and suppresses tap', () => {
        const onTap = vi.fn();
        const onLongPress = vi.fn();
        const manager = createSheetMessageInteractionManager();

        manager.start({ nativeEvent: { pageX: 48, pageY: 96 } }, { onTap, onLongPress });
        vi.advanceTimersByTime(500);
        manager.end({ nativeEvent: { pageX: 48, pageY: 96 } });

        expect(onLongPress).toHaveBeenCalledTimes(1);
        expect(onLongPress).toHaveBeenCalledWith({ pageX: 48, pageY: 96 });
        expect(onTap).not.toHaveBeenCalled();
    });

    it('cancels both tap and long press when the pointer moves away', () => {
        const onTap = vi.fn();
        const onLongPress = vi.fn();
        const manager = createSheetMessageInteractionManager();

        manager.start({ nativeEvent: { pageX: 12, pageY: 24 } }, { onTap, onLongPress });
        manager.move();
        vi.advanceTimersByTime(600);
        manager.end({ nativeEvent: { pageX: 12, pageY: 40 } });

        expect(onTap).not.toHaveBeenCalled();
        expect(onLongPress).not.toHaveBeenCalled();
    });
});
