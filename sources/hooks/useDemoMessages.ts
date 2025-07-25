import { useEffect } from 'react';
import { storage } from '@/sync/storage';
import { Message } from '@/sync/typesMessage';
import { createReducer } from '@/sync/reducer';

const DEMO_SESSION_ID = 'demo-messages-session';

export function useDemoMessages(messages: Message[]) {
    useEffect(() => {
        // Create messages map
        const messagesMap: Record<string, Message> = {};
        messages.forEach(msg => {
            messagesMap[msg.id] = msg;
        });

        // Sort messages by createdAt
        const sortedMessages = [...messages].sort((a, b) => b.createdAt - a.createdAt);

        // Write the demo messages to the hardcoded session
        storage.setState((state) => ({
            ...state,
            sessionMessages: {
                ...state.sessionMessages,
                [DEMO_SESSION_ID]: {
                    messages: sortedMessages,
                    messagesMap: messagesMap,
                    reducerState: createReducer(),
                    isLoaded: true
                }
            }
        }));

        // Cleanup function to remove the demo session
        return () => {
            storage.setState((state) => {
                const { [DEMO_SESSION_ID]: _, ...restSessions } = state.sessionMessages;
                return {
                    ...state,
                    sessionMessages: restSessions
                };
            });
        };
    }, [messages]);

    return DEMO_SESSION_ID;
}