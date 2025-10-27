import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useVoiceRecording } from './useVoiceRecording';
import { Audio } from 'expo-audio';

// Mock expo-audio
vi.mock('expo-audio', () => ({
    Audio: {
        requestPermissionsAsync: vi.fn(),
        setAudioModeAsync: vi.fn(),
        Recording: {
            createAsync: vi.fn(),
        },
        RecordingOptionsPresets: {
            HIGH_QUALITY: {},
        },
    },
}));

// Mock expo-file-system
vi.mock('expo-file-system', () => ({
    deleteAsync: vi.fn(),
}));

describe('useVoiceRecording', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('should initialize with isRecording = false', () => {
        const { result } = renderHook(() => useVoiceRecording());
        expect(result.current.isRecording).toBe(false);
    });

    it('should start recording when startRecording is called', async () => {
        const mockRecording = {
            stopAndUnloadAsync: vi.fn(),
            getURI: vi.fn().mockReturnValue('file://recording.m4a'),
            getStatusAsync: vi.fn().mockResolvedValue({ durationMillis: 5000 }),
        };

        (Audio.requestPermissionsAsync as any).mockResolvedValue({ granted: true });
        (Audio.Recording.createAsync as any).mockResolvedValue({ recording: mockRecording });

        const { result } = renderHook(() => useVoiceRecording());

        await act(async () => {
            await result.current.startRecording();
        });

        expect(result.current.isRecording).toBe(true);
        expect(Audio.requestPermissionsAsync).toHaveBeenCalled();
        expect(Audio.setAudioModeAsync).toHaveBeenCalledWith({
            allowsRecordingIOS: true,
            playsInSilentModeIOS: true,
        });
    });

    it('should throw error if microphone permission is denied', async () => {
        (Audio.requestPermissionsAsync as any).mockResolvedValue({ granted: false });

        const { result } = renderHook(() => useVoiceRecording());

        await expect(async () => {
            await act(async () => {
                await result.current.startRecording();
            });
        }).rejects.toThrow('Microphone permission not granted');
    });

    it('should stop recording and return result', async () => {
        const mockRecording = {
            stopAndUnloadAsync: vi.fn().mockResolvedValue(undefined),
            getURI: vi.fn().mockReturnValue('file://recording.m4a'),
            getStatusAsync: vi.fn().mockResolvedValue({ durationMillis: 5000 }),
        };

        (Audio.requestPermissionsAsync as any).mockResolvedValue({ granted: true });
        (Audio.Recording.createAsync as any).mockResolvedValue({ recording: mockRecording });

        const { result } = renderHook(() => useVoiceRecording());

        // Start recording
        await act(async () => {
            await result.current.startRecording();
        });

        expect(result.current.isRecording).toBe(true);

        // Stop recording
        let recordingResult;
        await act(async () => {
            recordingResult = await result.current.stopRecording();
        });

        expect(result.current.isRecording).toBe(false);
        expect(recordingResult).toEqual({
            uri: 'file://recording.m4a',
            duration: 5000,
        });
        expect(mockRecording.stopAndUnloadAsync).toHaveBeenCalled();
    });

    it('should cancel recording and delete file', async () => {
        const mockRecording = {
            stopAndUnloadAsync: vi.fn().mockResolvedValue(undefined),
            getURI: vi.fn().mockReturnValue('file://recording.m4a'),
        };

        const { deleteAsync } = await import('expo-file-system');
        (Audio.requestPermissionsAsync as any).mockResolvedValue({ granted: true });
        (Audio.Recording.createAsync as any).mockResolvedValue({ recording: mockRecording });

        const { result } = renderHook(() => useVoiceRecording());

        // Start recording
        await act(async () => {
            await result.current.startRecording();
        });

        // Cancel recording
        await act(async () => {
            await result.current.cancelRecording();
        });

        expect(result.current.isRecording).toBe(false);
        expect(deleteAsync).toHaveBeenCalledWith('file://recording.m4a', { idempotent: true });
    });
});
