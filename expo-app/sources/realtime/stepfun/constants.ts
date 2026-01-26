/**
 * StepFun Realtime API Constants
 */

export const STEPFUN_CONSTANTS = {
    // WebSocket endpoint
    WEBSOCKET_URL: 'wss://api.stepfun.com/v1/realtime',

    // Audio configuration (required by StepFun API)
    AUDIO: {
        SAMPLE_RATE: 24000,      // 24kHz required
        CHANNELS: 1,             // Mono
        BIT_DEPTH: 16,           // PCM16
        FRAME_SIZE: 4096,        // Buffer size (~170ms at 24kHz)
    },

    // Default model - step-1-flash for realtime voice
    DEFAULT_MODEL: 'step-1-flash',

    // Available voices
    VOICES: {
        QINGCHUN_SHAONV: 'qingchunshaonv',           // 青春少女
        WENROU_NANSHENG: 'wenrounansheng',           // 温柔男声
        ELEGANT_GENTLE_FEMALE: 'elegantgentle-female', // 优雅女声
        LIVELY_BREEZY_FEMALE: 'livelybreezy-female',   // 活泼女声
    },

    // Default voice
    DEFAULT_VOICE: 'qingchunshaonv',

    // Connection settings
    CONNECTION: {
        TIMEOUT_MS: 10000,
        MAX_RECONNECT_ATTEMPTS: 3,
        RECONNECT_DELAY_MS: 1000,
    },

    // VAD (Voice Activity Detection) settings
    VAD: {
        THRESHOLD: 0.5,
        PREFIX_PADDING_MS: 300,
        SILENCE_DURATION_MS: 500,
    },

    // Session limits
    SESSION: {
        MAX_DURATION_MINUTES: 30,
    },
} as const;
