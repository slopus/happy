import React, { useEffect, useRef } from 'react';
import { registerWhisperRecorder } from './RealtimeSession';

// Preferred MIME types in order: Opus is best for speech compression,
// mp4/AAC is the Safari fallback, generic webm as last resort.
const MIME_PREFERENCES = [
    'audio/webm;codecs=opus',
    'audio/mp4',
    'audio/webm',
];

function pickMimeType(): string {
    if (typeof MediaRecorder === 'undefined') return '';
    for (const mime of MIME_PREFERENCES) {
        if (MediaRecorder.isTypeSupported(mime)) return mime;
    }
    return ''; // let browser pick
}

// Module-level so apiVoice.ts can read it after recording
let lastRecordedMimeType = '';
export function getRecordedMimeType(): string {
    return lastRecordedMimeType;
}

export const WhisperRecorderComponent: React.FC = () => {
    const hasRegistered = useRef(false);
    const mediaRecorderRef = useRef<MediaRecorder | null>(null);
    const chunksRef = useRef<Blob[]>([]);

    useEffect(() => {
        if (hasRegistered.current) return;
        hasRegistered.current = true;

        registerWhisperRecorder({
            start: async () => {
                const stream = await navigator.mediaDevices.getUserMedia({
                    audio: {
                        channelCount: 1,       // mono — speech only
                        sampleRate: 16000,      // what Whisper uses internally
                        echoCancellation: true,
                        noiseSuppression: true,
                    },
                });

                const mimeType = pickMimeType();
                const options: MediaRecorderOptions = { bitsPerSecond: 32000 };
                if (mimeType) options.mimeType = mimeType;

                console.log('[Whisper] MediaRecorder MIME:', mimeType || '(browser default)',
                    '| bitsPerSecond: 32000');

                const mediaRecorder = new MediaRecorder(stream, options);
                lastRecordedMimeType = mediaRecorder.mimeType; // actual negotiated type
                mediaRecorderRef.current = mediaRecorder;
                chunksRef.current = [];

                mediaRecorder.ondataavailable = (e) => {
                    if (e.data.size > 0) {
                        chunksRef.current.push(e.data);
                    }
                };

                mediaRecorder.start();
            },
            stop: async () => {
                const mediaRecorder = mediaRecorderRef.current;
                if (!mediaRecorder) throw new Error('No active recording');

                return new Promise<string>((resolve, reject) => {
                    mediaRecorder.onstop = () => {
                        const actualType = lastRecordedMimeType || 'audio/webm';
                        const blob = new Blob(chunksRef.current, { type: actualType });
                        console.log('[Whisper] Recording blob:', blob.size, 'bytes, type:', actualType);
                        const url = URL.createObjectURL(blob);
                        // Stop all tracks to release the microphone
                        mediaRecorder.stream.getTracks().forEach(track => track.stop());
                        mediaRecorderRef.current = null;
                        chunksRef.current = [];
                        resolve(url);
                    };
                    mediaRecorder.onerror = () => reject(new Error('Recording failed'));
                    mediaRecorder.stop();
                });
            },
        });
    }, []);

    return null;
};
