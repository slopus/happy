import React from 'react';
import { ElevenLabsProvider } from '@elevenlabs/react-native';
import { ElevenLabsVoiceSession } from './ElevenLabsVoiceSession';
import { OpenAIVoiceSession } from './OpenAIVoiceSession';
import { useSetting } from '@/sync/storage';

export const RealtimeProvider = ({ children }: { children: React.ReactNode }) => {
    const voiceBackend = useSetting('voiceBackend');

    return (
        <ElevenLabsProvider>
            {voiceBackend === 'openai' ? <OpenAIVoiceSession /> : <ElevenLabsVoiceSession />}
            {children}
        </ElevenLabsProvider>
    );
};
