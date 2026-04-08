import { tracking } from '@/track';

export type VoiceUpsellVariant =
    | 'show-paywall-before-first-voice-chat'
    | 'voice-onboarding-and-upsell'
    | 'control';

export type VoiceUpsellVariantSource = 'posthog' | 'default';

export type VoiceGatingMode = 'direct-byo-agent' | 'happy-server';

function isVoiceUpsellVariant(value: unknown): value is Exclude<VoiceUpsellVariant, 'control'> {
    return value === 'show-paywall-before-first-voice-chat' || value === 'voice-onboarding-and-upsell';
}

export function getVoiceUpsellVariant(rawVariant: unknown = tracking?.getFeatureFlag('voice-upsell')): VoiceUpsellVariant {
    if (isVoiceUpsellVariant(rawVariant)) {
        return rawVariant;
    }
    return 'control';
}

export function getVoiceExperimentStatus(options: {
    voiceBypassToken: boolean;
    voiceCustomAgentId: string | null | undefined;
}): {
    upsellVariant: VoiceUpsellVariant;
    upsellVariantSource: VoiceUpsellVariantSource;
    gatingMode: VoiceGatingMode;
} {
    const rawVariant = tracking?.getFeatureFlag('voice-upsell');
    const gatingMode: VoiceGatingMode = options.voiceBypassToken && !!options.voiceCustomAgentId
        ? 'direct-byo-agent'
        : 'happy-server';

    return {
        upsellVariant: getVoiceUpsellVariant(rawVariant),
        upsellVariantSource: isVoiceUpsellVariant(rawVariant) ? 'posthog' : 'default',
        gatingMode,
    };
}
