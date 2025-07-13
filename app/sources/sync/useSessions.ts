import { useEffect, useState } from 'react';
import { sessionsEngine } from '@/sync/SessionsEngine';
import { Session } from '@/sync/types';

export function useSessions() {
    const [sessions, setSessions] = useState<Session[]>(sessionsEngine.getSessions());
    const [isLoaded, setIsLoaded] = useState<boolean>(sessionsEngine.getLoadedState());

    useEffect(() => {
        const unsubscribe = sessionsEngine.addListener((updatedSessions, loaded) => {
            setSessions(updatedSessions);
            setIsLoaded(loaded);
        });

        return () => {
            unsubscribe();
        }
    }, []);

    return {
        sessions,
        isLoaded,
        createSession: sessionsEngine.createSession.bind(sessionsEngine),
        sendMessage: sessionsEngine.sendMessage.bind(sessionsEngine),
        sendTextMessage: sessionsEngine.sendTextMessage.bind(sessionsEngine),
        getSession: sessionsEngine.getSession.bind(sessionsEngine),
        getSessionMessages: sessionsEngine.getSessionMessages.bind(sessionsEngine)
    };
}