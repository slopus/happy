import { useEffect, useState } from 'react';

// A single shared 1s ticker for every elapsed-time consumer. Each mounted
// useElapsedTime used to start its own setInterval, so a chat with many tool
// calls ran dozens of unsynchronized timers, each firing a setState on its own
// offset — re-renders scattered across every frame, forever, while the page
// stays open. One shared interval fires all subscribers on the same aligned
// tick, so React can batch their updates into a single render pass, and the
// timer stops entirely when nothing is listening.
type Listener = () => void;
const listeners = new Set<Listener>();
let interval: ReturnType<typeof setInterval> | null = null;

export function subscribeToTick(listener: Listener) {
    listeners.add(listener);
    if (interval === null) {
        interval = setInterval(() => {
            for (const l of listeners) l();
        }, 1000);
    }
    return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && interval !== null) {
            clearInterval(interval);
            interval = null;
        }
    };
}

export function useElapsedTime(date: Date | number | null | undefined): number {
    const [elapsedSeconds, setElapsedSeconds] = useState(0);

    useEffect(() => {
        if (!date) {
            setElapsedSeconds(0);
            return;
        }

        const timestamp = date instanceof Date ? date.getTime() : date;
        const compute = () => Math.max(0, Math.floor((Date.now() - timestamp) / 1000));

        // Initial value now; then only re-render when the whole second changes.
        setElapsedSeconds(compute());
        return subscribeToTick(() => {
            const next = compute();
            setElapsedSeconds(prev => (prev === next ? prev : next));
        });
    }, [date]);

    return elapsedSeconds;
}
