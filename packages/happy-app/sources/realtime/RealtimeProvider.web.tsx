import React from 'react';
import { RealtimeVoiceSession } from './RealtimeVoiceSession';
import { useVoiceSessionGeneration } from '@/sync/storage';

export const RealtimeProvider = ({ children }: { children: React.ReactNode }) => {
    // Web SDK (@elevenlabs/react) uses a plain WebSocket — no LiveKit Room to
    // go stale — so this re-key is mostly defensive. Kept symmetric with native.
    const generation = useVoiceSessionGeneration();
    return (
        <>
            <RealtimeVoiceSession key={generation} />
            {children}
        </>
    );
};
