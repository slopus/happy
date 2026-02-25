import React from 'react';
import { RealtimeVoiceSession } from './RealtimeVoiceSession';
import { WhisperRecorderComponent } from './WhisperRecorder';
import { useSetting } from '@/sync/storage';

export const RealtimeProvider = ({ children }: { children: React.ReactNode }) => {
    const voiceMode = useSetting('voiceMode');

    // Conditionally mount each voice component based on mode.
    // ElevenLabs useConversation hook can crash if SDK isn't configured,
    // so we only mount it when assistant mode is active.
    return (
        <>
            {voiceMode !== 'dictation' && <RealtimeVoiceSession />}
            {voiceMode === 'dictation' && <WhisperRecorderComponent />}
            {children}
        </>
    );
};
