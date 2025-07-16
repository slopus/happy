import { useEffect, useState } from 'react';
import { syncEngine } from '@/sync/SyncEngine';
import { Session } from '@/sync/types';

export function useSyncEngine() {
    const [sessions, setSessions] = useState<Session[]>(syncEngine.getSessions());
    const [isLoaded, setIsLoaded] = useState<boolean>(syncEngine.getLoadedState());

    useEffect(() => {
        const unsubscribe = syncEngine.addListener((updatedSessions, loaded) => {
            setSessions(updatedSessions);
            setIsLoaded(loaded);
        });

        return () => {
            unsubscribe();
        }
    }, []);

    return [sessions, isLoaded] as const;
}