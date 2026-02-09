import React, { useEffect } from 'react';
import { RealtimeVoiceSession } from './RealtimeVoiceSession';
import { HappyVoiceSession } from './HappyVoiceSession';
import { registerVoiceToolRpcHandlers } from './registerVoiceToolRpcHandlers';
import { getVoiceProvider } from '@/sync/voiceConfig';

export const RealtimeProvider = ({ children }: { children: React.ReactNode }) => {
    useEffect(() => {
        return registerVoiceToolRpcHandlers();
    }, []);

    if (getVoiceProvider() === 'happy-voice') {
        return (
            <>
                <HappyVoiceSession />
                {children}
            </>
        );
    }

    return (
        <>
            <RealtimeVoiceSession />
            {children}
        </>
    );
};
