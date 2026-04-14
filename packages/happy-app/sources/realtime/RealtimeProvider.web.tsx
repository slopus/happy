import React from 'react';
import { RealtimeVoiceSession } from './RealtimeVoiceSession';
import { useVoiceSessionGeneration } from '@/sync/storage';

export const RealtimeProvider = ({ children }: { children: React.ReactNode }) => {
    const generation = useVoiceSessionGeneration();

    return (
        <>
            <RealtimeVoiceSession key={generation} />
            {children}
        </>
    );
};
