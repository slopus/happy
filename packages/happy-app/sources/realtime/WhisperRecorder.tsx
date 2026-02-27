import React, { useEffect, useRef } from 'react';
import { useAudioRecorder, AudioModule, RecordingPresets, IOSOutputFormat, AudioQuality } from 'expo-audio';
import type { RecordingOptions } from 'expo-audio';
import { registerWhisperRecorder } from './RealtimeSession';

// Optimized for speech dictation: mono, 16kHz, low bitrate AAC.
// Whisper internally resamples to 16kHz mono anyway, so this avoids
// recording (and uploading) data that gets thrown away.
const SPEECH_DICTATION: RecordingOptions = {
    extension: '.m4a',
    sampleRate: 16000,
    numberOfChannels: 1,
    bitRate: 48000,
    android: {
        outputFormat: 'mpeg4',
        audioEncoder: 'aac',
    },
    ios: {
        outputFormat: IOSOutputFormat.MPEG4AAC,
        audioQuality: AudioQuality.MEDIUM,
    },
    web: {
        mimeType: 'audio/mp4',
        bitsPerSecond: 48000,
    },
};

export const WhisperRecorderComponent: React.FC = () => {
    const audioRecorder = useAudioRecorder(SPEECH_DICTATION);
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
