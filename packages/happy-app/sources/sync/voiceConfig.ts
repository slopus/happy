import { MMKV } from 'react-native-mmkv';
import type { AppConfig } from './appConfig';

// Separate MMKV instance for voice config that persists across logouts
const voiceConfigStorage = new MMKV({ id: 'voice-config' });

const KEYS = {
    provider: 'voice-provider',
    elevenLabsAgentId: 'voice-elevenlabs-agent-id',
    liveKitGatewayUrl: 'voice-livekit-gateway-url',
    liveKitPublicKey: 'voice-livekit-public-key',
} as const;

type VoiceProvider = 'elevenlabs' | 'livekit';

// Keep a reference to the app config for fallback defaults
let configRef: AppConfig | undefined;

// ── Provider ────────────────────────────────────────────────────────

export function getVoiceProvider(): VoiceProvider {
    const stored = voiceConfigStorage.getString(KEYS.provider);
    if (stored === 'elevenlabs' || stored === 'livekit') return stored;
    return configRef?.voiceProvider || 'elevenlabs';
}

export function setVoiceProvider(value: VoiceProvider | null): void {
    if (value) {
        voiceConfigStorage.set(KEYS.provider, value);
    } else {
        voiceConfigStorage.delete(KEYS.provider);
    }
    notifyProviderChange();
}

export function isUsingCustomVoiceProvider(): boolean {
    return voiceConfigStorage.contains(KEYS.provider);
}

// ── ElevenLabs ──────────────────────────────────────────────────────

export function getElevenLabsAgentId(): string | undefined {
    const stored = voiceConfigStorage.getString(KEYS.elevenLabsAgentId);
    if (stored) return stored;
    // Fallback to env-derived config (unified, no dev/prod split for user)
    return __DEV__ ? configRef?.elevenLabsAgentIdDev : configRef?.elevenLabsAgentIdProd;
}

export function setElevenLabsAgentId(value: string | null): void {
    if (value && value.trim()) {
        voiceConfigStorage.set(KEYS.elevenLabsAgentId, value.trim());
    } else {
        voiceConfigStorage.delete(KEYS.elevenLabsAgentId);
    }
}

export function hasCustomElevenLabsAgentId(): boolean {
    return voiceConfigStorage.contains(KEYS.elevenLabsAgentId);
}

// ── LiveKit / Happy Voice ───────────────────────────────────────────

export function getLiveKitGatewayUrl(): string | undefined {
    const stored = voiceConfigStorage.getString(KEYS.liveKitGatewayUrl);
    if (stored) return stored;
    return configRef?.voiceBaseUrl;
}

export function setLiveKitGatewayUrl(value: string | null): void {
    if (value && value.trim()) {
        voiceConfigStorage.set(KEYS.liveKitGatewayUrl, value.trim());
    } else {
        voiceConfigStorage.delete(KEYS.liveKitGatewayUrl);
    }
}

export function hasCustomLiveKitGatewayUrl(): boolean {
    return voiceConfigStorage.contains(KEYS.liveKitGatewayUrl);
}

export function getLiveKitPublicKey(): string | undefined {
    const stored = voiceConfigStorage.getString(KEYS.liveKitPublicKey);
    if (stored) return stored;
    return configRef?.voicePublicKey;
}

export function setLiveKitPublicKey(value: string | null): void {
    if (value && value.trim()) {
        voiceConfigStorage.set(KEYS.liveKitPublicKey, value.trim());
    } else {
        voiceConfigStorage.delete(KEYS.liveKitPublicKey);
    }
}

export function hasCustomLiveKitPublicKey(): boolean {
    return voiceConfigStorage.contains(KEYS.liveKitPublicKey);
}

// ── Utilities ───────────────────────────────────────────────────────

export function isUsingCustomVoiceConfig(): boolean {
    return isUsingCustomVoiceProvider()
        || hasCustomElevenLabsAgentId()
        || hasCustomLiveKitGatewayUrl()
        || hasCustomLiveKitPublicKey();
}

export function resetVoiceConfig(): void {
    voiceConfigStorage.delete(KEYS.provider);
    voiceConfigStorage.delete(KEYS.elevenLabsAgentId);
    voiceConfigStorage.delete(KEYS.liveKitGatewayUrl);
    voiceConfigStorage.delete(KEYS.liveKitPublicKey);
    notifyProviderChange();
}

export function validateUrl(url: string): { valid: boolean; error?: string } {
    if (!url || !url.trim()) {
        return { valid: false, error: 'URL cannot be empty' };
    }
    try {
        const parsed = new URL(url);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            return { valid: false, error: 'URL must use HTTP or HTTPS protocol' };
        }
        return { valid: true };
    } catch {
        return { valid: false, error: 'Invalid URL format' };
    }
}

// ── Provider change listener ────────────────────────────────────────

type Listener = () => void;
const listeners: Listener[] = [];

export function onVoiceProviderChange(fn: Listener): () => void {
    listeners.push(fn);
    return () => {
        const idx = listeners.indexOf(fn);
        if (idx >= 0) listeners.splice(idx, 1);
    };
}

function notifyProviderChange(): void {
    for (const fn of listeners) fn();
}

// ── Init ────────────────────────────────────────────────────────────

/**
 * Called once at startup from config.ts.
 * Saves a reference to the app config for fallback defaults,
 * and syncs MMKV overrides into the mutable config object so
 * existing code that reads config.* gets the right values.
 */
export function initVoiceConfig(config: AppConfig): void {
    configRef = config;

    // Sync MMKV overrides into the config object
    const provider = voiceConfigStorage.getString(KEYS.provider);
    if (provider === 'elevenlabs' || provider === 'livekit') {
        config.voiceProvider = provider;
    }

    const agentId = voiceConfigStorage.getString(KEYS.elevenLabsAgentId);
    if (agentId) {
        config.elevenLabsAgentIdDev = agentId;
        config.elevenLabsAgentIdProd = agentId;
    }

    const gatewayUrl = voiceConfigStorage.getString(KEYS.liveKitGatewayUrl);
    if (gatewayUrl) {
        config.voiceBaseUrl = gatewayUrl;
    }

    const publicKey = voiceConfigStorage.getString(KEYS.liveKitPublicKey);
    if (publicKey) {
        config.voicePublicKey = publicKey;
    }
}
