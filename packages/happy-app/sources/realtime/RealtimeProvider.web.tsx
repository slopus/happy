import React from 'react';
import { ElevenLabsVoiceSession } from './ElevenLabsVoiceSession';
import { OpenAIVoiceSession } from './OpenAIVoiceSession';
import { useSetting } from '@/sync/storage';

export const RealtimeProvider = ({ children }: { children: React.ReactNode }) => {
    const voiceBackend = useSetting('voiceBackend');

    return (
        <>
            {voiceBackend === 'openai' ? <OpenAIVoiceSession /> : <ElevenLabsVoiceSession />}
            {children}
        </>
    );
};
