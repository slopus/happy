export interface SheetMessageInteractionPoint {
    pageX: number;
    pageY: number;
}

export interface SheetMessageInteractionEvent {
    nativeEvent: SheetMessageInteractionPoint;
}

export interface SheetMessageInteractionCallbacks {
    onTap: () => void;
    onLongPress: (point: SheetMessageInteractionPoint) => void;
}

interface CreateSheetMessageInteractionManagerOptions {
    longPressDelayMs?: number;
    tapMaxDurationMs?: number;
    tapMoveThresholdPx?: number;
    now?: () => number;
    setTimer?: typeof setTimeout;
    clearTimer?: typeof clearTimeout;
}

function getInteractionPoint(event: SheetMessageInteractionEvent | SheetMessageInteractionPoint): SheetMessageInteractionPoint {
    return 'nativeEvent' in event ? event.nativeEvent : event;
}

export function createSheetMessageInteractionManager(options: CreateSheetMessageInteractionManagerOptions = {}) {
    const {
        longPressDelayMs = 500,
        tapMaxDurationMs = 400,
        tapMoveThresholdPx = 8,
        now = Date.now,
        setTimer = setTimeout,
        clearTimer = clearTimeout,
    } = options;

    let pressStartedAt = 0;
    let startPoint: SheetMessageInteractionPoint | null = null;
    let callbacks: SheetMessageInteractionCallbacks | null = null;
    let longPressTriggered = false;
    let longPressTimer: ReturnType<typeof setTimeout> | null = null;

    const clearLongPressTimer = () => {
        if (!longPressTimer) {
            return;
        }

        clearTimer(longPressTimer);
        longPressTimer = null;
    };

    const reset = () => {
        clearLongPressTimer();
        pressStartedAt = 0;
        startPoint = null;
        callbacks = null;
        longPressTriggered = false;
    };

    return {
        start(
            event: SheetMessageInteractionEvent | SheetMessageInteractionPoint,
            nextCallbacks: SheetMessageInteractionCallbacks,
        ) {
            clearLongPressTimer();

            pressStartedAt = now();
            startPoint = getInteractionPoint(event);
            callbacks = nextCallbacks;
            longPressTriggered = false;

            longPressTimer = setTimer(() => {
                if (!startPoint || !callbacks) {
                    return;
                }

                longPressTriggered = true;
                longPressTimer = null;
                callbacks.onLongPress(startPoint);
            }, longPressDelayMs);
        },

        move() {
            clearLongPressTimer();
        },

        end(event: SheetMessageInteractionEvent | SheetMessageInteractionPoint) {
            const endPoint = getInteractionPoint(event);
            const canTap =
                !longPressTriggered &&
                !!startPoint &&
                !!callbacks &&
                now() - pressStartedAt <= tapMaxDurationMs &&
                Math.abs(endPoint.pageY - startPoint.pageY) <= tapMoveThresholdPx;

            const onTap = callbacks?.onTap;
            reset();

            if (canTap && onTap) {
                onTap();
            }
        },

        cancel() {
            reset();
        },

        dispose() {
            reset();
        },
    };
}
