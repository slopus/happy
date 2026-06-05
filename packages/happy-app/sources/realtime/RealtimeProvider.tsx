import React from 'react';
import { ElevenLabsProvider } from '@elevenlabs/react-native';
import { RealtimeVoiceSession } from './RealtimeVoiceSession';
import { useVoiceSessionGeneration } from '@/sync/storage';

export const RealtimeProvider = ({ children }: { children: React.ReactNode }) => {
    // Force ElevenLabsProvider to remount between sessions. The native SDK uses
    // LiveKit, whose Room instance can't be reused after disconnect — second
    // startSession silently fails. Children sit OUTSIDE the provider so the app
    // tree isn't torn down on remount.
    const generation = useVoiceSessionGeneration();
    return (
        <>
            <ElevenLabsProvider key={generation}>
                <RealtimeVoiceSession />
            </ElevenLabsProvider>
            {children}
        </>
    );
};
