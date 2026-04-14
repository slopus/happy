import React from 'react';
import { ElevenLabsProvider } from "@elevenlabs/react-native";
import { RealtimeVoiceSession } from './RealtimeVoiceSession';
import { useVoiceSessionGeneration } from '@/sync/storage';

export const RealtimeProvider = ({ children }: { children: React.ReactNode }) => {
    // Force ElevenLabsProvider + useConversation hook to remount between
    // voice sessions — the SDK doesn't clean up LiveKit state properly,
    // causing the second startSession() to silently fail.
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
