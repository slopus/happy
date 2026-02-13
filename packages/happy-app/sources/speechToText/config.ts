/**
 * Speech-to-Text Module Configuration
 *
 * Default configurations and model metadata for the STT feature.
 */

import { WhisperModelInfo, WhisperModelSize } from './types';

// =============================================================================
// Whisper Model Configurations
// =============================================================================

/**
 * Hugging Face base URL for Whisper models
 */
const HF_BASE_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main';

/**
 * Available Whisper model configurations
 */
export const WHISPER_MODELS: Record<WhisperModelSize, WhisperModelInfo> = {
    tiny: {
        size: 'tiny',
        displayName: 'Tiny',
        fileSize: 75 * 1024 * 1024,  // ~75MB
        downloadUrl: `${HF_BASE_URL}/ggml-tiny.bin`,
        coreMLUrl: `${HF_BASE_URL}/ggml-tiny-encoder.mlmodelc.zip`,
        languages: ['en', 'zh', 'ja', 'ko', 'es', 'fr', 'de', 'it', 'pt', 'ru'],
    },
    base: {
        size: 'base',
        displayName: 'Base',
        fileSize: 142 * 1024 * 1024,  // ~142MB
        downloadUrl: `${HF_BASE_URL}/ggml-base.bin`,
        coreMLUrl: `${HF_BASE_URL}/ggml-base-encoder.mlmodelc.zip`,
        languages: ['en', 'zh', 'ja', 'ko', 'es', 'fr', 'de', 'it', 'pt', 'ru'],
    },
    small: {
        size: 'small',
        displayName: 'Small',
        fileSize: 466 * 1024 * 1024,  // ~466MB
        downloadUrl: `${HF_BASE_URL}/ggml-small.bin`,
        coreMLUrl: `${HF_BASE_URL}/ggml-small-encoder.mlmodelc.zip`,
        languages: ['en', 'zh', 'ja', 'ko', 'es', 'fr', 'de', 'it', 'pt', 'ru', 'ar', 'hi', 'th', 'vi'],
    },
    medium: {
        size: 'medium',
        displayName: 'Medium',
        fileSize: 1500 * 1024 * 1024,  // ~1.5GB
        downloadUrl: `${HF_BASE_URL}/ggml-medium.bin`,
        coreMLUrl: `${HF_BASE_URL}/ggml-medium-encoder.mlmodelc.zip`,
        languages: ['en', 'zh', 'ja', 'ko', 'es', 'fr', 'de', 'it', 'pt', 'ru', 'ar', 'hi', 'th', 'vi'],
    },
};

// =============================================================================
// Language Mappings
// =============================================================================

/**
 * Map from common language codes to Whisper-compatible codes
 */
export const LANGUAGE_CODE_MAP: Record<string, string> = {
    // Chinese variants
    'zh-CN': 'zh',
    'zh-Hans': 'zh',
    'zh-TW': 'zh',
    'zh-Hant': 'zh',
    'cmn': 'zh',

    // English variants
    'en-US': 'en',
    'en-GB': 'en',
    'en-AU': 'en',

    // Japanese
    'ja-JP': 'ja',

    // Korean
    'ko-KR': 'ko',

    // Spanish variants
    'es-ES': 'es',
    'es-MX': 'es',
    'es-AR': 'es',

    // French variants
    'fr-FR': 'fr',
    'fr-CA': 'fr',

    // German
    'de-DE': 'de',

    // Italian
    'it-IT': 'it',

    // Portuguese variants
    'pt-BR': 'pt',
    'pt-PT': 'pt',

    // Russian
    'ru-RU': 'ru',

    // Arabic
    'ar-SA': 'ar',

    // Hindi
    'hi-IN': 'hi',

    // Thai
    'th-TH': 'th',

    // Vietnamese
    'vi-VN': 'vi',
};

/**
 * Convert app language code to Whisper language code
 */
export function toWhisperLanguageCode(langCode: string | null | undefined): string | undefined {
    if (!langCode) return undefined;

    // Check direct mapping
    if (LANGUAGE_CODE_MAP[langCode]) {
        return LANGUAGE_CODE_MAP[langCode];
    }

    // Try base language code (e.g., 'zh' from 'zh-CN')
    const baseLang = langCode.split('-')[0].toLowerCase();
    if (LANGUAGE_CODE_MAP[baseLang]) {
        return LANGUAGE_CODE_MAP[baseLang];
    }

    // Return as-is if it's already a simple code
    if (baseLang.length === 2) {
        return baseLang;
    }

    return undefined;
}

// =============================================================================
// Audio Configuration
// =============================================================================

/**
 * Audio recording configuration for Whisper
 */
export const AUDIO_CONFIG = {
    /** Sample rate required by Whisper */
    sampleRate: 16000,
    /** Number of channels (mono) */
    channels: 1,
    /** Bits per sample */
    bitsPerSample: 16,
    /** Audio encoding format */
    encoding: 'pcm_16bit' as const,
};

// =============================================================================
// Timeouts and Limits
// =============================================================================

/**
 * Default timeouts and limits
 */
export const STT_LIMITS = {
    /** Maximum recording duration in seconds */
    maxRecordingDuration: 120,
    /** Silence detection threshold (seconds of silence before auto-stop) */
    silenceThreshold: 3,
    /** Minimum audio duration to process (seconds) */
    minAudioDuration: 0.5,
    /** Audio level update interval (ms) */
    audioLevelInterval: 50,
};

// =============================================================================
// Storage Keys
// =============================================================================

/**
 * Storage keys for STT data
 */
export const STT_STORAGE_KEYS = {
    /** Prefix for model files */
    modelPrefix: 'stt_model_',
    /** Model metadata */
    modelMetadata: 'stt_model_metadata',
};

// =============================================================================
// Cloud Provider Configurations
// =============================================================================

/**
 * Deepgram API configuration
 */
export const DEEPGRAM_CONFIG = {
    wsUrl: 'wss://api.deepgram.com/v1/listen',
    model: 'nova-2',
    defaultOptions: {
        smart_format: true,
        interim_results: true,
        punctuate: true,
        encoding: 'linear16',
        sample_rate: 16000,
    },
};
