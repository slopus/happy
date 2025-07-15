import { useEffect, useState } from 'react';
import { syncSessions } from './SyncSessions';
import { SyncMessage, SyncSessionState } from './SyncSession';
import * as React from 'react';
import { Session } from './types';

interface UseSyncSessionState {
    session: Session;
    messages: SyncMessage[];
    isLoading: boolean;
    abort: () => Promise<void>;
}

export function useSyncSession(sessionId: string): UseSyncSessionState {
    const allSessions = syncSessions.getSessions();
    let session1 = allSessions.find(s => s.id === sessionId)!;
    const session = React.useMemo(() => syncSessions.getSession(sessionId), [sessionId]);
    const [state, setState] = useState<SyncSessionState>(session.getState());
    useEffect(() => {
        session.addListener(setState);
        return () => {
            session.removeListener(setState);
        };
    }, [sessionId]);
    const result = React.useMemo(() => ({ session: session1, messages: state.messages, isLoading: state.isLoading, abort: session.abort }), [session1, state]);
    return result;
}