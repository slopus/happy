import { useEffect, useState } from 'react';
import { syncSessions } from './SyncSessions';
import { SyncMessage } from './SyncSession';
import * as React from 'react';

interface UseSyncSessionState {
    messages: SyncMessage[];
    isLoading: boolean;
}

export function useSyncSession(sessionId: string): UseSyncSessionState {
    const session = React.useMemo(() => syncSessions.getSession(sessionId), [sessionId]);
    const [state, setState] = useState<UseSyncSessionState>(session.getState());
    useEffect(() => {
        session.addListener(setState);
        return () => {
            session.removeListener(setState);
        };
    }, [sessionId]);
    return state;
}