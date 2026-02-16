/**
 * StepFun ASR Provider
 *
 * Implements ASR using StepFun's audio transcription API.
 * API Documentation: https://platform.stepfun.com/docs/en/api-reference/audio/transcriptions
 */

import type { ASRProvider, ASROptions, ASRResult, AudioData } from '../types';

const STEPFUN_ASR_ENDPOINT = 'https://api.stepfun.com/v1/audio/transcriptions';
const STEPFUN_ASR_MODEL = 'step-asr';

export interface StepFunASRConfig {
    apiKey: string;
}

export class StepFunASRProvider implements ASRProvider {
    readonly name = 'stepfun' as const;
    private config: StepFunASRConfig | null = null;

    constructor(config?: StepFunASRConfig) {
        if (config) {
            this.config = config;
        }
    }

    /**
     * Update the provider configuration
     */
    setConfig(config: StepFunASRConfig): void {
        this.config = config;
    }

    /**
     * Check if the provider is properly configured
     */
    isConfigured(): boolean {
        return !!this.config?.apiKey;
    }

    /**
     * Transcribe audio to text using StepFun ASR API
     */
    async transcribe(audio: AudioData, options?: ASROptions): Promise<ASRResult> {
        if (!this.isConfigured()) {
            throw new Error('StepFun ASR is not configured. Please set API key in settings.');
        }

        const startTime = Date.now();

        try {
            // Create form data for multipart upload
            const formData = new FormData();

            // Handle both Blob and base64 formats
            if (audio instanceof Blob) {
                // Web: Use Blob directly
                const format = options?.format || this.getFormatFromMimeType(audio.type) || 'wav';
                const fileName = `audio.${format}`;
                formData.append('file', audio, fileName);
                console.log(`[StepFunASR] Transcribing audio (Blob): size=${audio.size}, format=${format}`);
            } else {
                // Native: Use base64 data URI format for React Native FormData
                const dataUri = `data:${audio.mimeType};base64,${audio.base64}`;
                // React Native FormData accepts { uri, type, name } objects
                formData.append('file', {
                    uri: dataUri,
                    type: audio.mimeType,
                    name: audio.fileName,
                } as unknown as Blob);
                console.log(`[StepFunASR] Transcribing audio (base64): fileName=${audio.fileName}`);
            }

            // Append model (required)
            formData.append('model', STEPFUN_ASR_MODEL);

            // Append response format (optional, default: json)
            formData.append('response_format', options?.responseFormat || 'json');

            // Append hotwords if provided
            if (options?.hotwords && options.hotwords.length > 0) {
                formData.append('hotwords', JSON.stringify(options.hotwords));
            }

            const response = await fetch(STEPFUN_ASR_ENDPOINT, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${this.config!.apiKey}`,
                },
                body: formData,
            });

            if (!response.ok) {
                const errorText = await response.text();
                console.error(`[StepFunASR] API error: ${response.status} - ${errorText}`);
                throw new Error(`StepFun ASR API error: ${response.status} - ${errorText}`);
            }

            const responseFormat = options?.responseFormat || 'json';

            if (responseFormat === 'text') {
                const text = await response.text();
                const durationMs = Date.now() - startTime;
                console.log(`[StepFunASR] Transcription complete: "${text.slice(0, 50)}..." (${durationMs}ms)`);
                return { text, durationMs };
            }

            const result = await response.json();
            const durationMs = Date.now() - startTime;

            console.log(`[StepFunASR] Transcription complete: "${result.text?.slice(0, 50)}..." (${durationMs}ms)`);

            return {
                text: result.text || '',
                durationMs,
            };
        } catch (error) {
            console.error('[StepFunASR] Transcription failed:', error);
            throw error;
        }
    }

    /**
     * Get audio format from MIME type
     */
    private getFormatFromMimeType(mimeType: string): string | null {
        const mimeToFormat: Record<string, string> = {
            'audio/wav': 'wav',
            'audio/x-wav': 'wav',
            'audio/webm': 'webm',
            'audio/mp3': 'mp3',
            'audio/mpeg': 'mp3',
            'audio/flac': 'flac',
            'audio/ogg': 'ogg',
            'audio/mp4': 'mp4',
            'audio/m4a': 'm4a',
            'audio/aac': 'aac',
            'audio/opus': 'opus',
        };
        return mimeToFormat[mimeType] || null;
    }
}
