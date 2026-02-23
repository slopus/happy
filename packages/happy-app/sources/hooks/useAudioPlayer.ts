import { useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';
import * as React from 'react';

// Global state: which message is currently playing
let currentPlayingId: number | null = null;
const listeners = new Set<() => void>();
function notifyAll() { listeners.forEach(fn => fn()); }

/**
 * Audio player hook for DooTask voice messages.
 * Ensures only one voice message plays at a time (global singleton pattern).
 */
export function useDootaskAudioPlayer(msgId: number, audioUrl: string) {
    const player = useAudioPlayer(audioUrl || undefined);
    const status = useAudioPlayerStatus(player);
    const [, forceUpdate] = React.useReducer((x: number) => x + 1, 0);

    // Subscribe to global play state changes
    React.useEffect(() => {
        listeners.add(forceUpdate);
        return () => { listeners.delete(forceUpdate); };
    }, []);

    // If another message started playing, pause this one
    React.useEffect(() => {
        if (currentPlayingId !== null && currentPlayingId !== msgId && status.playing) {
            player.pause();
        }
    }, [currentPlayingId, msgId, status.playing, player]);

    const isPlaying = status.playing && currentPlayingId === msgId;

    const toggle = React.useCallback(() => {
        if (!audioUrl) return;
        if (isPlaying) {
            player.pause();
            currentPlayingId = null;
            notifyAll();
        } else {
            currentPlayingId = msgId;
            player.seekTo(0);
            player.play();
            notifyAll();
        }
    }, [isPlaying, player, msgId, audioUrl]);

    // Auto-stop when playback ends
    React.useEffect(() => {
        if (status.didJustFinish && currentPlayingId === msgId) {
            currentPlayingId = null;
            notifyAll();
        }
    }, [status.didJustFinish, msgId]);

    // Stop on unmount if this is the playing one
    React.useEffect(() => {
        return () => {
            if (currentPlayingId === msgId) {
                player.pause();
                currentPlayingId = null;
                notifyAll();
            }
        };
    }, [msgId, player]);

    return { isPlaying, toggle };
}
