import React, { useEffect, useRef } from 'react';
import { registerWhisperRecorder } from './RealtimeSession';

export const WhisperRecorderComponent: React.FC = () => {
    const hasRegistered = useRef(false);
    const mediaRecorderRef = useRef<MediaRecorder | null>(null);
    const chunksRef = useRef<Blob[]>([]);

    useEffect(() => {
        if (hasRegistered.current) return;
        hasRegistered.current = true;

        registerWhisperRecorder({
            start: async () => {
                const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
                const mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
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
                        const blob = new Blob(chunksRef.current, { type: 'audio/webm' });
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
