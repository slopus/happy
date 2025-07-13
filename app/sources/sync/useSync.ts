import { useEffect, useState } from 'react';
import { syncEngine, SyncEngineState } from '@/sync/SyncEngine';

export function useSync() {
    const [syncState, setSyncState] = useState<SyncEngineState>(syncEngine.getState());

    useEffect(() => {
        const unsubscribe = syncEngine.addListener((state) => {
            setSyncState(state);
        });

        return () => {
            unsubscribe();
        }
    }, []);

    return {
        ...syncState,
        send: syncEngine.send.bind(syncEngine),
        onMessage: syncEngine.onMessage.bind(syncEngine)
    };
}