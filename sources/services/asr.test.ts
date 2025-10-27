import { describe, it, expect, beforeEach, vi } from 'vitest';
import { transcribeAudio, cleanupAudioFile } from './asr';
import * as FileSystem from 'expo-file-system';

// Mock expo-file-system
vi.mock('expo-file-system', () => ({
    getInfoAsync: vi.fn(),
    deleteAsync: vi.fn(),
}));

// Mock global fetch
global.fetch = vi.fn();

describe('ASR Service', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    describe('transcribeAudio', () => {
        it('should successfully transcribe audio', async () => {
            const mockAudioUri = 'file://recording.m4a';
            const mockTranscriptionText = 'Hello world';

            // Mock file exists
            (FileSystem.getInfoAsync as any).mockResolvedValue({ exists: true });

            // Mock fetch for reading audio file
            const mockBlob = new Blob(['audio data'], { type: 'audio/m4a' });
            (global.fetch as any)
                .mockResolvedValueOnce({
                    blob: () => Promise.resolve(mockBlob),
                })
                // Mock ElevenLabs Scribe API response
                .mockResolvedValueOnce({
                    ok: true,
                    json: () => Promise.resolve({
                        text: mockTranscriptionText,
                        confidence: 0.95
                    }),
                });

            const result = await transcribeAudio(mockAudioUri, {
                apiKey: 'test-api-key',
                language: 'en',
            });

            expect(result).toEqual({
                text: mockTranscriptionText,
                confidence: 0.95,
            });
            expect(global.fetch).toHaveBeenCalledTimes(2);
        });

        it('should throw error if audio file does not exist', async () => {
            const mockAudioUri = 'file://nonexistent.m4a';

            (FileSystem.getInfoAsync as any).mockResolvedValue({ exists: false });

            await expect(
                transcribeAudio(mockAudioUri, { apiKey: 'test-api-key' })
            ).rejects.toThrow('Audio file does not exist');
        });

        it('should throw error if API key is not configured', async () => {
            const mockAudioUri = 'file://recording.m4a';

            (FileSystem.getInfoAsync as any).mockResolvedValue({ exists: true });

            // Clear environment variable
            const originalEnv = process.env.EXPO_PUBLIC_ELEVENLABS_API_KEY;
            delete process.env.EXPO_PUBLIC_ELEVENLABS_API_KEY;

            await expect(transcribeAudio(mockAudioUri)).rejects.toThrow(
                'ElevenLabs API key not configured'
            );

            // Restore environment variable
            if (originalEnv) {
                process.env.EXPO_PUBLIC_ELEVENLABS_API_KEY = originalEnv;
            }
        });

        it('should handle API errors', async () => {
            const mockAudioUri = 'file://recording.m4a';

            (FileSystem.getInfoAsync as any).mockResolvedValue({ exists: true });

            const mockBlob = new Blob(['audio data'], { type: 'audio/m4a' });
            (global.fetch as any)
                .mockResolvedValueOnce({
                    blob: () => Promise.resolve(mockBlob),
                })
                .mockResolvedValueOnce({
                    ok: false,
                    status: 400,
                    json: () =>
                        Promise.resolve({
                            detail: 'Invalid audio format',
                        }),
                });

            await expect(
                transcribeAudio(mockAudioUri, { apiKey: 'test-api-key' })
            ).rejects.toThrow('ElevenLabs ASR error: 400 - Invalid audio format');
        });
    });

    describe('cleanupAudioFile', () => {
        it('should delete audio file', async () => {
            const mockAudioUri = 'file://recording.m4a';

            await cleanupAudioFile(mockAudioUri);

            expect(FileSystem.deleteAsync).toHaveBeenCalledWith(mockAudioUri, {
                idempotent: true,
            });
        });

        it('should handle deletion errors gracefully', async () => {
            const mockAudioUri = 'file://recording.m4a';

            (FileSystem.deleteAsync as any).mockRejectedValue(
                new Error('Permission denied')
            );

            // Should not throw
            await expect(cleanupAudioFile(mockAudioUri)).resolves.toBeUndefined();
        });
    });
});
