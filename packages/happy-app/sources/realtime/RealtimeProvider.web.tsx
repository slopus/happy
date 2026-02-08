import React, { useEffect } from 'react';
import { RealtimeVoiceSession } from './RealtimeVoiceSession';
import { LiveKitVoiceSession } from './LiveKitVoiceSession';
import { registerVoiceToolRpcHandlers } from './registerVoiceToolRpcHandlers';
import { config } from '@/config';

export const RealtimeProvider = ({ children }: { children: React.ReactNode }) => {
    useEffect(() => {
        return registerVoiceToolRpcHandlers();
    }, []);

    if (config.voiceProvider === 'livekit') {
        return (
            <>
                <LiveKitVoiceSession />
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
