import * as FileSystem from 'expo-file-system';

export interface ASRResult {
    text: string;
    confidence?: number;
}

export interface ASRConfig {
    apiKey?: string;
    language?: string;
}

/**
 * ASR Service using ElevenLabs Scribe API
 *
 * This service converts audio recordings to text using ElevenLabs' Scribe model.
 * Uses the same ElevenLabs API key as the existing realtime conversation feature.
 *
 * @example
 * const result = await transcribeAudio(audioUri, {
 *   apiKey: 'your-elevenlabs-api-key',
 *   language: 'en'
 * });
 * console.log('Transcribed text:', result.text);
 */

/**
 * Transcribe audio file to text using ElevenLabs Scribe API
 *
 * @param audioUri - URI of the audio file (from expo-audio recording)
 * @param config - ASR configuration including API key and language
 * @returns Transcribed text with optional confidence score
 */
export async function transcribeAudio(
    audioUri: string,
    config: ASRConfig = {}
): Promise<ASRResult> {
    try {
        // Read audio file
        const audioInfo = await FileSystem.getInfoAsync(audioUri);
        if (!audioInfo.exists) {
            throw new Error('Audio file does not exist');
        }

        // Use ElevenLabs API key (shared with realtime conversation feature)
        const apiKey = config.apiKey || process.env.EXPO_PUBLIC_ELEVENLABS_API_KEY;
        if (!apiKey) {
            throw new Error('ElevenLabs API key not configured');
        }

        // Create form data
        const formData = new FormData();

        // Read file as blob
        const response = await fetch(audioUri);
        const blob = await response.blob();

        formData.append('audio', blob, 'recording.m4a');

        if (config.language) {
            formData.append('language', config.language);
        }

        // Call ElevenLabs Scribe API
        const apiResponse = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
            method: 'POST',
            headers: {
                'xi-api-key': apiKey,
            },
            body: formData,
        });

        if (!apiResponse.ok) {
            const errorData = await apiResponse.json().catch(() => ({}));
            throw new Error(
                `ElevenLabs ASR error: ${apiResponse.status} - ${errorData.detail || errorData.message || 'Unknown error'}`
            );
        }

        const data = await apiResponse.json();

        return {
            text: data.text || '',
            confidence: data.confidence
        };
    } catch (error) {
        console.error('ASR transcription failed:', error);
        throw error;
    }
}

/**
 * Clean up audio file after transcription
 *
 * @param audioUri - URI of the audio file to delete
 */
export async function cleanupAudioFile(audioUri: string): Promise<void> {
    try {
        await FileSystem.deleteAsync(audioUri, { idempotent: true });
        console.log('Audio file cleaned up:', audioUri);
    } catch (error) {
        console.error('Failed to cleanup audio file:', error);
    }
}
