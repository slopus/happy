import React from 'react';
import { ConversationProvider } from '@elevenlabs/react';
import { RealtimeVoiceSession } from './RealtimeVoiceSession';
import { useVoiceProviderGeneration } from '@/sync/storage';

export const RealtimeProvider = ({ children }: { children: React.ReactNode }) => {
    const providerGeneration = useVoiceProviderGeneration();
    return (
        <>
            <ConversationProvider key={providerGeneration}>
                <RealtimeVoiceSession />
            </ConversationProvider>
            {children}
        </>
    );
};
