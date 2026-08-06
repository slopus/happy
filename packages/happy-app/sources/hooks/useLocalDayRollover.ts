import * as React from 'react';
import { AppState } from 'react-native';

import { getLocalDayIndex } from '@/utils/sessionNavigationGroups';

/**
 * Returns the current local-calendar day and refreshes it at midnight or when
 * the app becomes active, so date-based labels cannot remain stale overnight.
 */
export function useLocalDayRollover(): number {
    const [localDayIndex, setLocalDayIndex] = React.useState(() => getLocalDayIndex(Date.now()));

    React.useEffect(() => {
        let rolloverTimer: ReturnType<typeof setTimeout> | null = null;

        const scheduleRollover = () => {
            if (rolloverTimer) clearTimeout(rolloverTimer);

            const now = new Date();
            setLocalDayIndex(getLocalDayIndex(now.getTime()));

            const nextMidnight = new Date(
                now.getFullYear(),
                now.getMonth(),
                now.getDate() + 1,
            );
            rolloverTimer = setTimeout(
                scheduleRollover,
                Math.max(1_000, nextMidnight.getTime() - now.getTime() + 100),
            );
        };

        const appStateSubscription = AppState.addEventListener('change', (state) => {
            if (state === 'active') scheduleRollover();
        });
        scheduleRollover();

        return () => {
            if (rolloverTimer) clearTimeout(rolloverTimer);
            appStateSubscription.remove();
        };
    }, []);

    return localDayIndex;
}
