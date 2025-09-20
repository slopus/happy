import { ElevenLabsProvider } from '@elevenlabs/react-native';
import React from 'react';

import { RealtimeVoiceSession } from './RealtimeVoiceSession';

export const RealtimeProvider = ({ children }: { children: React.ReactNode }) => {
  return (
    <ElevenLabsProvider>
      <RealtimeVoiceSession />
      {children}
    </ElevenLabsProvider>
  );
};