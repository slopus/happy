import { useEffect, useState } from 'react';
import { syncSessions } from '@/sync/SyncSessions';
import { Session } from '@/sync/types';

export function useSessions() {
    const [sessions, setSessions] = useState<Session[]>(syncSessions.getSessions());
    const [isLoaded, setIsLoaded] = useState<boolean>(syncSessions.getLoadedState());

    useEffect(() => {
        const unsubscribe = syncSessions.addListener((updatedSessions, loaded) => {
            setSessions(updatedSessions);
            setIsLoaded(loaded);
        });

        return () => {
            unsubscribe();
        }
    }, []);

    return [sessions, isLoaded] as const;
}