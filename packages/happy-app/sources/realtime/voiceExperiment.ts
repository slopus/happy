import { tracking } from '@/track';

export const VOICE_UPSELL_FLAG_KEY = 'voice-upsell';

export type VoiceUpsellVariant =
    | 'show-paywall-before-first-voice-chat'
    | 'voice-onboarding-and-upsell'
    | 'control';

export type VoiceUpsellVariantSource = 'override' | 'posthog' | 'default';

export type VoiceGatingMode = 'direct-byo-agent' | 'happy-server';

type PostHogFeatureFlagOverrideClient = {
    featureFlags?: {
        overrideFeatureFlags?: (options: {
            flags: Record<string, string | boolean>;
        }) => void;
    };
};

function isVoiceUpsellVariant(value: unknown): value is Exclude<VoiceUpsellVariant, 'control'> {
    return value === 'show-paywall-before-first-voice-chat' || value === 'voice-onboarding-and-upsell';
}

export function getVoiceUpsellVariantLabel(variant: VoiceUpsellVariant): string {
    switch (variant) {
        case 'control':
            return 'Control';
        case 'show-paywall-before-first-voice-chat':
            return 'Soft paywall before first voice chat';
        case 'voice-onboarding-and-upsell':
            return 'Voice onboarding and upsell';
    }
}

export function applyVoiceUpsellOverride(override: VoiceUpsellVariant | null) {
    if (!override) {
        return;
    }

    const client = tracking as PostHogFeatureFlagOverrideClient | null;
    client?.featureFlags?.overrideFeatureFlags?.({
        flags: {
            [VOICE_UPSELL_FLAG_KEY]: override,
        },
    });
}

export function getVoiceUpsellVariant(options?: {
    rawVariant?: unknown;
    override?: VoiceUpsellVariant | null;
    overrideEnabled?: boolean;
}): VoiceUpsellVariant {
    if (options?.overrideEnabled && options.override) {
        return options.override;
    }

    const rawVariant = options?.rawVariant ?? tracking?.getFeatureFlag(VOICE_UPSELL_FLAG_KEY);
    if (isVoiceUpsellVariant(rawVariant)) {
        return rawVariant;
    }
    return 'control';
}

export function getVoiceExperimentStatus(options: {
    voiceBypassToken: boolean;
    voiceCustomAgentId: string | null | undefined;
    voiceUpsellOverride?: VoiceUpsellVariant | null;
    voiceUpsellOverrideEnabled?: boolean;
}): {
    upsellVariant: VoiceUpsellVariant;
    upsellVariantSource: VoiceUpsellVariantSource;
    gatingMode: VoiceGatingMode;
} {
    const rawVariant = tracking?.getFeatureFlag(VOICE_UPSELL_FLAG_KEY);
    const gatingMode: VoiceGatingMode = options.voiceBypassToken && !!options.voiceCustomAgentId
        ? 'direct-byo-agent'
        : 'happy-server';
    const hasOverride = !!options.voiceUpsellOverrideEnabled && !!options.voiceUpsellOverride;

    return {
        upsellVariant: getVoiceUpsellVariant({
            rawVariant,
            override: options.voiceUpsellOverride,
            overrideEnabled: options.voiceUpsellOverrideEnabled,
        }),
        upsellVariantSource: hasOverride ? 'override' : isVoiceUpsellVariant(rawVariant) ? 'posthog' : 'default',
        gatingMode,
    };
}
