import { useEffect, useRef, useState } from 'react';
import { SyncSession, SyncMessage } from './SyncSession';
import { MessageContent } from './types';

interface UseSyncSessionState {
    messages: SyncMessage[];
    isLoading: boolean;
    error: string | null;
    sendMessage: (content: MessageContent) => Promise<void>;
    retryMessage: (messageId: string) => Promise<void>;
}

export function useSyncSession(sessionId: string): UseSyncSessionState {
    const syncSessionRef = useRef<SyncSession | null>(null);
    const [state, setState] = useState<UseSyncSessionState>({
        messages: [],
        isLoading: false,
        error: null,
        sendMessage: async () => {},
        retryMessage: async () => {}
    });

    useEffect(() => {
        // Create new sync session
        const syncSession = new SyncSession(sessionId);
        syncSessionRef.current = syncSession;

        // Subscribe to state updates
        const listener = (sessionState: any) => {
            setState({
                messages: sessionState.messages,
                isLoading: sessionState.isLoading,
                error: sessionState.error,
                sendMessage: (content: MessageContent) => syncSession.sendMessage(content),
                retryMessage: (messageId: string) => syncSession.retryMessage(messageId)
            });
        };

        syncSession.addListener(listener);
        syncSession.startSync();

        // Cleanup on unmount or sessionId change
        return () => {
            syncSession.removeListener(listener);
            syncSession.dispose();
            syncSessionRef.current = null;
        };
    }, [sessionId]);

    return state;
}