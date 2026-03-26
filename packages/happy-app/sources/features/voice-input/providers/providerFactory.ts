import { VoiceButtonDecision, VoiceButtonState, VoiceInputMode, VoiceModeStrategy } from './types';

const streamingAsrStrategy: VoiceModeStrategy = {
    mode: 'streaming_asr',
    decideButton: () => ({
        showStreamingAsrButton: true,
        showSendButton: false,
        showLegacyMicButton: false
    })
};

const elevenlabsCallStrategy: VoiceModeStrategy = {
    mode: 'elevenlabs_call',
    decideButton: (state) => {
        const showSendButton = state.hasText || !!state.isSending || !!state.isMicActive;
        const showLegacyMicButton = !showSendButton && state.hasMicAction && !state.isMicActive;
        return {
            showStreamingAsrButton: false,
            showSendButton,
            showLegacyMicButton
        };
    }
};

const strategyByMode: Record<VoiceInputMode, VoiceModeStrategy> = {
    streaming_asr: streamingAsrStrategy,
    elevenlabs_call: elevenlabsCallStrategy
};

export function resolveVoiceInputMode(mode?: string | null): VoiceInputMode {
    return mode === 'streaming_asr' ? 'streaming_asr' : 'elevenlabs_call';
}

export function getVoiceModeStrategy(mode?: string | null): VoiceModeStrategy {
    return strategyByMode[resolveVoiceInputMode(mode)];
}

export function decideVoiceButton(mode: VoiceInputMode, state: VoiceButtonState): VoiceButtonDecision {
    return strategyByMode[mode].decideButton(state);
}
