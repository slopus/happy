import { renderHook, act, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach, Mock } from 'vitest';
import { useLocalVAD } from './useLocalVAD';
import * as ExpoAudioStudio from 'expo-audio-studio';

// Mock expo-audio-studio
vi.mock('expo-audio-studio', () => ({
    setVADEnabled: vi.fn(),
    setVoiceActivityThreshold: vi.fn(),
    addVoiceActivityListener: vi.fn(() => ({
        remove: vi.fn(),
    })),
}));

// Mock console methods
const originalConsoleLog = console.log;
const originalConsoleError = console.error;

describe('useLocalVAD', () => {
    let mockListener: Mock;
    let mockSubscription: { remove: Mock };

    beforeEach(() => {
        vi.clearAllMocks();

        // Setup default mocks
        mockSubscription = { remove: vi.fn() };
        mockListener = vi.fn();

        (ExpoAudioStudio.addVoiceActivityListener as Mock).mockImplementation((callback: any) => {
            mockListener = callback;
            return mockSubscription;
        });

        // Suppress console output in tests
        console.log = vi.fn();
        console.error = vi.fn();
    });

    afterEach(() => {
        vi.restoreAllMocks();
        console.log = originalConsoleLog;
        console.error = originalConsoleError;
    });

    describe('when VAD is disabled', () => {
        it('should not start VAD when enabled is false', () => {
            const onSpeechStart = vi.fn();
            const onSpeechEnd = vi.fn();

            const { result } = renderHook(() => useLocalVAD({
                enabled: false,
                onSpeechStart,
                onSpeechEnd,
            }));

            expect(result.current.isListening).toBe(false);
            expect(result.current.isSpeaking).toBe(false);
            expect(result.current.confidence).toBe(0);
            expect(ExpoAudioStudio.setVADEnabled).toHaveBeenCalledWith(false);
        });

        it('should have default threshold value', () => {
            const { result } = renderHook(() => useLocalVAD({
                enabled: false,
            }));

            expect(result.current.confidence).toBe(0);
        });
    });

    describe('when VAD is enabled', () => {
        it('should start VAD successfully', () => {
            const onSpeechStart = vi.fn();
            const onSpeechEnd = vi.fn();

            renderHook(() => useLocalVAD({
                enabled: true,
                threshold: 0.7,
                onSpeechStart,
                onSpeechEnd,
            }));

            expect(ExpoAudioStudio.setVADEnabled).toHaveBeenCalledWith(true);
            expect(ExpoAudioStudio.setVoiceActivityThreshold).toHaveBeenCalledWith(0.7);
            expect(ExpoAudioStudio.addVoiceActivityListener).toHaveBeenCalled();
        });

        it('should detect speech start', () => {
            const onSpeechStart = vi.fn();
            const onSpeechEnd = vi.fn();

            const { result } = renderHook(() => useLocalVAD({
                enabled: true,
                onSpeechStart,
                onSpeechEnd,
            }));

            // Simulate voice activity event: speech started
            act(() => {
                mockListener({
                    isVoiceDetected: true,
                    confidence: 0.85,
                });
            });

            expect(onSpeechStart).toHaveBeenCalledTimes(1);
            expect(result.current.isSpeaking).toBe(true);
            expect(result.current.confidence).toBe(0.85);
        });

        it('should detect speech end', () => {
            const onSpeechStart = vi.fn();
            const onSpeechEnd = vi.fn();

            const { result } = renderHook(() => useLocalVAD({
                enabled: true,
                onSpeechStart,
                onSpeechEnd,
            }));

            // Start speech
            act(() => {
                mockListener({
                    isVoiceDetected: true,
                    confidence: 0.85,
                });
            });

            expect(onSpeechStart).toHaveBeenCalledTimes(1);

            // End speech
            act(() => {
                mockListener({
                    isVoiceDetected: false,
                    confidence: 0.15,
                });
            });

            expect(onSpeechEnd).toHaveBeenCalledTimes(1);
            expect(result.current.isSpeaking).toBe(false);
            expect(result.current.confidence).toBe(0.15);
        });

        it('should call onVoiceActivity callback', () => {
            const onVoiceActivity = vi.fn();

            renderHook(() => useLocalVAD({
                enabled: true,
                onVoiceActivity,
            }));

            // Simulate voice activity event
            act(() => {
                mockListener({
                    isVoiceDetected: true,
                    confidence: 0.9,
                });
            });

            expect(onVoiceActivity).toHaveBeenCalledWith(true, 0.9);
        });

        it('should pause VAD successfully', () => {
            const { result } = renderHook(() => useLocalVAD({
                enabled: true,
            }));

            // Start some speech
            act(() => {
                mockListener({
                    isVoiceDetected: true,
                    confidence: 0.8,
                });
            });

            expect(result.current.isSpeaking).toBe(true);

            // Pause VAD
            act(() => {
                result.current.pause();
            });

            expect(ExpoAudioStudio.setVADEnabled).toHaveBeenLastCalledWith(false);
            expect(result.current.isListening).toBe(false);
            expect(result.current.isSpeaking).toBe(false);
            expect(result.current.confidence).toBe(0);
        });

        it('should cleanup on unmount', () => {
            const { unmount } = renderHook(() => useLocalVAD({
                enabled: true,
            }));

            unmount();

            expect(mockSubscription.remove).toHaveBeenCalled();
            expect(ExpoAudioStudio.setVADEnabled).toHaveBeenLastCalledWith(false);
        });

        it('should update threshold when changed', () => {
            const { rerender } = renderHook(
                ({ threshold }) => useLocalVAD({
                    enabled: true,
                    threshold,
                }),
                { initialProps: { threshold: 0.5 } }
            );

            expect(ExpoAudioStudio.setVoiceActivityThreshold).toHaveBeenCalledWith(0.5);

            // Change threshold
            rerender({ threshold: 0.8 });

            expect(ExpoAudioStudio.setVoiceActivityThreshold).toHaveBeenCalledWith(0.8);
        });
    });

    describe('speech transition detection', () => {
        it('should only call onSpeechStart once per speech segment', () => {
            const onSpeechStart = vi.fn();

            renderHook(() => useLocalVAD({
                enabled: true,
                onSpeechStart,
            }));

            // Multiple voice detected events (continuous speech on iOS)
            act(() => {
                mockListener({ isVoiceDetected: true, confidence: 0.85 });
            });
            act(() => {
                mockListener({ isVoiceDetected: true, confidence: 0.90 });
            });
            act(() => {
                mockListener({ isVoiceDetected: true, confidence: 0.87 });
            });

            // Should only call once at the start
            expect(onSpeechStart).toHaveBeenCalledTimes(1);
        });

        it('should only call onSpeechEnd once per silence segment', () => {
            const onSpeechEnd = vi.fn();

            renderHook(() => useLocalVAD({
                enabled: true,
                onSpeechEnd,
            }));

            // Start speech
            act(() => {
                mockListener({ isVoiceDetected: true, confidence: 0.85 });
            });

            // Multiple silence events
            act(() => {
                mockListener({ isVoiceDetected: false, confidence: 0.15 });
            });
            act(() => {
                mockListener({ isVoiceDetected: false, confidence: 0.10 });
            });
            act(() => {
                mockListener({ isVoiceDetected: false, confidence: 0.12 });
            });

            // Should only call once at speech end
            expect(onSpeechEnd).toHaveBeenCalledTimes(1);
        });

        it('should handle multiple speech segments correctly', () => {
            const onSpeechStart = vi.fn();
            const onSpeechEnd = vi.fn();

            renderHook(() => useLocalVAD({
                enabled: true,
                onSpeechStart,
                onSpeechEnd,
            }));

            // First speech segment
            act(() => {
                mockListener({ isVoiceDetected: true, confidence: 0.85 });
            });
            expect(onSpeechStart).toHaveBeenCalledTimes(1);

            act(() => {
                mockListener({ isVoiceDetected: false, confidence: 0.15 });
            });
            expect(onSpeechEnd).toHaveBeenCalledTimes(1);

            // Second speech segment
            act(() => {
                mockListener({ isVoiceDetected: true, confidence: 0.90 });
            });
            expect(onSpeechStart).toHaveBeenCalledTimes(2);

            act(() => {
                mockListener({ isVoiceDetected: false, confidence: 0.10 });
            });
            expect(onSpeechEnd).toHaveBeenCalledTimes(2);
        });
    });

    describe('exposed properties', () => {
        it('should expose all required properties', () => {
            const { result } = renderHook(() => useLocalVAD({
                enabled: true,
                threshold: 0.6,
            }));

            expect(result.current).toHaveProperty('start');
            expect(result.current).toHaveProperty('pause');
            expect(result.current).toHaveProperty('isListening');
            expect(result.current).toHaveProperty('isSpeaking');
            expect(result.current).toHaveProperty('confidence');

            // Verify functions are callable
            expect(typeof result.current.start).toBe('function');
            expect(typeof result.current.pause).toBe('function');

            // Verify initial states
            expect(result.current.isListening).toBe(true);
            expect(result.current.isSpeaking).toBe(false);
            expect(result.current.confidence).toBe(0);
        });
    });

    describe('error handling', () => {
        it('should handle missing callbacks gracefully', () => {
            const { result } = renderHook(() => useLocalVAD({
                enabled: true,
                // No callbacks provided
            }));

            // Should not throw when triggering events
            expect(() => {
                act(() => {
                    mockListener({
                        isVoiceDetected: true,
                        confidence: 0.85,
                    });
                });
            }).not.toThrow();

            expect(result.current.isSpeaking).toBe(true);
        });
    });
});