import * as React from 'react';
import { Platform } from 'react-native';

const AcquireDrawerSwipeLockContext = React.createContext<(() => () => void) | null>(null);
const DrawerSwipeLockedContext = React.createContext(false);

// Each focused panel owns its lock: an old screen's cleanup must not unlock
// a newer screen's panel while both screens are mounted by the navigator.
export function AndroidDrawerSwipeLockProvider({ children }: { children: React.ReactNode }) {
    const [locks, setLocks] = React.useState<ReadonlySet<symbol>>(() => new Set());
    const acquire = React.useCallback(() => {
        const token = Symbol();
        setLocks((current) => new Set(current).add(token));
        return () => setLocks((current) => {
            if (!current.has(token)) return current;
            const next = new Set(current);
            next.delete(token);
            return next;
        });
    }, []);

    return (
        <AcquireDrawerSwipeLockContext.Provider value={acquire}>
            <DrawerSwipeLockedContext.Provider value={locks.size > 0}>
                {children}
            </DrawerSwipeLockedContext.Provider>
        </AcquireDrawerSwipeLockContext.Provider>
    );
}

export function useAndroidDrawerSwipeLocked() {
    return React.useContext(DrawerSwipeLockedContext);
}

export function useAndroidDrawerSwipeLock(active: boolean) {
    const acquire = React.useContext(AcquireDrawerSwipeLockContext);
    React.useLayoutEffect(() => {
        if (Platform.OS !== 'android' || !active) return;
        return acquire?.();
    }, [acquire, active]);
}
