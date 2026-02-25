import React from 'react';
import { ElevenLabsProvider } from "@elevenlabs/react-native";
import { RealtimeVoiceSession } from './RealtimeVoiceSession';
import { WhisperRecorderComponent } from './WhisperRecorder';
import { useSetting } from '@/sync/storage';

export const RealtimeProvider = ({ children }: { children: React.ReactNode }) => {
    const voiceMode = useSetting('voiceMode');

    // Conditionally mount each voice component based on mode.
    // ElevenLabs useConversation hook needs ElevenLabsProvider,
    // so we only wrap with it when assistant mode is active.
    if (voiceMode === 'dictation') {
        return (
            <>
                <WhisperRecorderComponent />
                {children}
            </>
        );
    }

    return (
        <ElevenLabsProvider>
            <RealtimeVoiceSession />
            {children}
        </ElevenLabsProvider>
    );
};
