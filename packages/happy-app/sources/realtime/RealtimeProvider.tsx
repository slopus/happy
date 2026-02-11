import React, { useEffect, useState } from 'react';
import { ElevenLabsProvider } from "@elevenlabs/react-native";
import { RealtimeVoiceSession } from './RealtimeVoiceSession';
import { HappyVoiceSession } from './HappyVoiceSession';
import { registerVoiceToolRpcHandlers } from './registerVoiceToolRpcHandlers';
import { getVoiceProvider, onVoiceProviderChange } from '@/sync/voiceConfig';

export const RealtimeProvider = ({ children }: { children: React.ReactNode }) => {
    const [provider, setProvider] = useState(getVoiceProvider);
    useEffect(() => onVoiceProviderChange(() => setProvider(getVoiceProvider())), []);

    useEffect(() => {
        return registerVoiceToolRpcHandlers();
    }, []);

    return (
        <ElevenLabsProvider>
            {provider === 'happy-voice' ? <HappyVoiceSession /> : <RealtimeVoiceSession />}
            {children}
        </ElevenLabsProvider>
    );
};
