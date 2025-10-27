import { useEffect, useCallback, useRef, useState } from 'react';
import {
    setVADEnabled,
    addVoiceActivityListener,
    setVoiceActivityThreshold,
} from 'expo-audio-studio';
import type { VoiceActivityEvent } from 'expo-audio-studio';

export interface UseLocalVADProps {
    /**
     * Whether VAD is enabled
     */
    enabled: boolean;

    /**
     * Detection threshold (0.0-1.0)
     * Lower = more sensitive (detects quieter speech)
     * Higher = less sensitive (only detects louder speech)
     * Default: 0.5
     */
    threshold?: number;

    /**
     * Callback when speech starts
     */
    onSpeechStart?: () => void;

    /**
     * Callback when speech ends
     */
    onSpeechEnd?: () => void;

    /**
     * Callback when voice activity is detected
     * @param isVoiceDetected - Whether voice is currently detected
     * @param confidence - Confidence score (0.0-1.0)
     */
    onVoiceActivity?: (isVoiceDetected: boolean, confidence: number) => void;
}

export interface UseLocalVADReturn {
    /**
     * Whether VAD is currently active/listening
     */
    isListening: boolean;

    /**
     * Whether speech is currently being detected
     */
    isSpeaking: boolean;

    /**
     * Current confidence score (0.0-1.0)
     */
    confidence: number;

    /**
     * Start listening for voice activity
     */
    start: () => void;

    /**
     * Pause voice activity detection
     */
    pause: () => void;
}

/**
 * Hook to manage local Voice Activity Detection (VAD) using expo-audio-studio
 *
 * This hook uses:
 * - iOS: Core ML Sound Classification (continuous events with real confidence scores)
 * - Android: Silero VAD (state-change events only with fixed confidence values)
 *
 * Platform-specific behavior:
 * - iOS: Receives events continuously (~60-100ms intervals) with real ML confidence scores
 * - Android: Receives events only when voice activity state changes (speech/silence transitions)
 *
 * @example
 * ```typescript
 * const { isSpeaking, isListening, confidence } = useLocalVAD({
 *     enabled: true,
 *     threshold: 0.5,
 *     onSpeechStart: () => console.log('Speech started'),
 *     onSpeechEnd: () => console.log('Speech ended'),
 * });
 * ```
 */
export function useLocalVAD(props: UseLocalVADProps): UseLocalVADReturn {
    const {
        enabled,
        threshold = 0.5,
        onSpeechStart,
        onSpeechEnd,
        onVoiceActivity,
    } = props;

    const [isListening, setIsListening] = useState(false);
    const [isSpeaking, setIsSpeaking] = useState(false);
    const [confidence, setConfidence] = useState(0);

    // Track previous speaking state to detect transitions
    const wasSpeakingRef = useRef(false);

    const start = useCallback(() => {
        if (enabled) {
            setVADEnabled(true);
            setIsListening(true);
        }
    }, [enabled]);

    const pause = useCallback(() => {
        setVADEnabled(false);
        setIsListening(false);
        setIsSpeaking(false);
        setConfidence(0);
        wasSpeakingRef.current = false;
    }, []);

    // Set VAD enabled/disabled based on enabled prop
    useEffect(() => {
        if (enabled) {
            setVADEnabled(true);
            setIsListening(true);
        } else {
            setVADEnabled(false);
            setIsListening(false);
            setIsSpeaking(false);
            setConfidence(0);
        }

        return () => {
            // Cleanup: disable VAD when unmounting
            setVADEnabled(false);
        };
    }, [enabled]);

    // Set VAD threshold
    useEffect(() => {
        if (enabled) {
            setVoiceActivityThreshold(threshold);
        }
    }, [enabled, threshold]);

    // Listen to voice activity events
    useEffect(() => {
        if (!enabled) return;

        const subscription = addVoiceActivityListener((event: VoiceActivityEvent) => {
            const { isVoiceDetected, confidence: eventConfidence } = event;

            // Update state
            setIsSpeaking(isVoiceDetected);
            setConfidence(eventConfidence);

            // Notify parent component
            onVoiceActivity?.(isVoiceDetected, eventConfidence);

            // Detect speech start/end transitions
            if (isVoiceDetected && !wasSpeakingRef.current) {
                // Speech started
                onSpeechStart?.();
            } else if (!isVoiceDetected && wasSpeakingRef.current) {
                // Speech ended
                onSpeechEnd?.();
            }

            // Update ref for next iteration
            wasSpeakingRef.current = isVoiceDetected;
        });

        return () => {
            subscription.remove();
        };
    }, [enabled, onSpeechStart, onSpeechEnd, onVoiceActivity]);

    return {
        isListening,
        isSpeaking,
        confidence,
        start,
        pause,
    };
}