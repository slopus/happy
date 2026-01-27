import { InteractionManager, Platform } from 'react-native';

type PendingFlushTimer = ReturnType<typeof setTimeout>;

type ScheduleDebouncedPendingSettingsFlushParams = {
    getTimer: () => PendingFlushTimer | null;
    setTimer: (timer: PendingFlushTimer) => void;
    markDirty: () => void;
    consumeDirty: () => boolean;
    flush: () => void;
    delayMs: number;
};

export function scheduleDebouncedPendingSettingsFlush({
    getTimer,
    setTimer,
    markDirty,
    consumeDirty,
    flush,
    delayMs,
}: ScheduleDebouncedPendingSettingsFlushParams) {
    const timer = getTimer();
    if (timer) {
        clearTimeout(timer);
    }

    markDirty();

    // Debounce disk write + network sync to keep UI interactions snappy.
    // IMPORTANT: JSON.stringify + MMKV.set are synchronous and can stall taps on iOS if run too often.
    setTimer(
        setTimeout(() => {
            if (!consumeDirty()) {
                return;
            }

            if (Platform.OS === 'web') {
                flush();
            } else {
                InteractionManager.runAfterInteractions(flush);
            }
        }, delayMs),
    );
}

