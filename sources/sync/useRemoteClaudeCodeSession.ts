import { useEffect, useState } from 'react';
import { syncEngine } from './SyncEngine';
import { SyncMessage, SyncSessionState } from './RemoteClaudeCodeSession';
import * as React from 'react';
import { Session } from './types';

interface UseSyncSessionState {
    session: Session;
    messages: SyncMessage[];
    isLoading: boolean;
    abort: () => Promise<void>;
}

export function useRemoteClaudeCodeSession(sessionId: string): UseSyncSessionState {
    const allSessions = syncEngine.getSessions();
    let session1 = allSessions.find(s => s.id === sessionId)!;
    const session = React.useMemo(() => syncEngine.getSession(sessionId), [sessionId]);
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

export function useOneMessage(sessionId: string, messageId: string): SyncMessage | null {
    // NOTE: This is inefficient - subscribes to ALL messages even when only interested in one.
    // Could be optimized by maintaining a map of messageId -> Set<listener> to only notify
    // components that care about specific messages, but keeping it simple for now.
    const { messages } = useRemoteClaudeCodeSession(sessionId);
    return messages.find(m => m.id === messageId) || null;
}