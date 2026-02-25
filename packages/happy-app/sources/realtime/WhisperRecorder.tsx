import React, { useEffect, useRef } from 'react';
import { useAudioRecorder, AudioModule, RecordingPresets } from 'expo-audio';
import { registerWhisperRecorder } from './RealtimeSession';

export const WhisperRecorderComponent: React.FC = () => {
    const audioRecorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
    const hasRegistered = useRef(false);
    const recorderRef = useRef(audioRecorder);
    recorderRef.current = audioRecorder;

    useEffect(() => {
        if (hasRegistered.current) return;
        hasRegistered.current = true;

        registerWhisperRecorder({
            start: async () => {
                await AudioModule.setAudioModeAsync({
                    allowsRecording: true,
                    playsInSilentMode: true,
                });
                await recorderRef.current.record();
            },
            stop: async () => {
                await recorderRef.current.stop();
                const uri = recorderRef.current.uri;
                if (!uri) throw new Error('No recording URI available');
                return uri;
            },
        });
    }, []);

    return null;
};
