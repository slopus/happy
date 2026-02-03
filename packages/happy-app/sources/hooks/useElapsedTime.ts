import { useEffect, useState } from 'react';

export function useElapsedTime(date: Date | number | null | undefined): number {
    const [elapsedSeconds, setElapsedSeconds] = useState(0);

    useEffect(() => {
        // Handle null/undefined dates
        if (!date) {
            setElapsedSeconds(0);
            return;
        }

        // Convert to timestamp if Date object
        const timestamp = date instanceof Date ? date.getTime() : date;

        // Update function to calculate elapsed seconds
        const updateElapsed = () => {
            const now = Date.now();
            const elapsed = Math.max(0, Math.floor((now - timestamp) / 1000));
            setElapsedSeconds(elapsed);
        };

        // Initial update
        updateElapsed();

        // Set up interval to update every second
        const interval = setInterval(updateElapsed, 1000);

        // Cleanup
        return () => {
            clearInterval(interval);
        };
    }, [date]);

    return elapsedSeconds;
}