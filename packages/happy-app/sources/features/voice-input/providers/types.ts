export type VoiceInputMode = 'elevenlabs_call' | 'streaming_asr';

export interface VoiceButtonState {
    hasText: boolean;
    isSending?: boolean;
    hasMicAction: boolean;
    isMicActive?: boolean;
}

export interface VoiceButtonDecision {
    showStreamingAsrButton: boolean;
    showSendButton: boolean;
    showLegacyMicButton: boolean;
}

export interface VoiceModeStrategy {
    mode: VoiceInputMode;
    decideButton: (state: VoiceButtonState) => VoiceButtonDecision;
}
