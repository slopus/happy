import { describe, it, expect } from 'vitest';
import { decideVoiceButton, getVoiceModeStrategy, resolveVoiceInputMode } from './providerFactory';

describe('resolveVoiceInputMode', () => {
    it('returns streaming_asr for streaming mode', () => {
        expect(resolveVoiceInputMode('streaming_asr')).toBe('streaming_asr');
    });

    it('falls back to elevenlabs_call for unknown values', () => {
        expect(resolveVoiceInputMode('unknown')).toBe('elevenlabs_call');
        expect(resolveVoiceInputMode(undefined)).toBe('elevenlabs_call');
        expect(resolveVoiceInputMode(null)).toBe('elevenlabs_call');
    });
});

describe('decideVoiceButton', () => {
    it('always shows streaming button in streaming_asr mode', () => {
        expect(decideVoiceButton('streaming_asr', {
            hasText: false,
            isSending: false,
            hasMicAction: true,
            isMicActive: false
        })).toEqual({
            showStreamingAsrButton: true,
            showSendButton: false,
            showLegacyMicButton: false
        });
    });

    it('shows send button when text exists in elevenlabs mode', () => {
        expect(decideVoiceButton('elevenlabs_call', {
            hasText: true,
            isSending: false,
            hasMicAction: true,
            isMicActive: false
        })).toEqual({
            showStreamingAsrButton: false,
            showSendButton: true,
            showLegacyMicButton: false
        });
    });

    it('shows send button when mic is active in elevenlabs mode', () => {
        expect(decideVoiceButton('elevenlabs_call', {
            hasText: false,
            isSending: false,
            hasMicAction: true,
            isMicActive: true
        })).toEqual({
            showStreamingAsrButton: false,
            showSendButton: true,
            showLegacyMicButton: false
        });
    });

    it('shows legacy mic button when idle and mic action is available', () => {
        expect(decideVoiceButton('elevenlabs_call', {
            hasText: false,
            isSending: false,
            hasMicAction: true,
            isMicActive: false
        })).toEqual({
            showStreamingAsrButton: false,
            showSendButton: false,
            showLegacyMicButton: true
        });
    });

    it('shows inactive state when idle and mic action is unavailable', () => {
        expect(decideVoiceButton('elevenlabs_call', {
            hasText: false,
            isSending: false,
            hasMicAction: false,
            isMicActive: false
        })).toEqual({
            showStreamingAsrButton: false,
            showSendButton: false,
            showLegacyMicButton: false
        });
    });
});

describe('getVoiceModeStrategy', () => {
    it('returns streaming strategy for streaming mode', () => {
        expect(getVoiceModeStrategy('streaming_asr').mode).toBe('streaming_asr');
    });

    it('returns fallback strategy for unknown mode', () => {
        expect(getVoiceModeStrategy('other').mode).toBe('elevenlabs_call');
    });
});
