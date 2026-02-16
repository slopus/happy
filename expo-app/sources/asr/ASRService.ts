/**
 * ASR Service
 *
 * Manages ASR providers and provides a unified interface for speech-to-text.
 * Reads configuration from app settings and instantiates the appropriate provider.
 */

import { storage } from '@/sync/storage';
import type { ASRProvider, ASRProviderType, ASROptions, ASRResult, ASRConfig, AudioData } from './types';
import { StepFunASRProvider } from './providers/StepFunASRProvider';

/**
 * Singleton ASR Service that manages provider instances
 */
class ASRServiceClass {
    private providers: Map<ASRProviderType, ASRProvider> = new Map();
    private currentProviderType: ASRProviderType = 'none';

    constructor() {
        // Initialize providers
        this.providers.set('stepfun', new StepFunASRProvider());
    }

    /**
     * Get the current ASR configuration from settings
     */
    private getConfig(): ASRConfig {
        const state = storage.getState();
        const settings = state.settings;

        return {
            provider: (settings.asrProvider as ASRProviderType) || 'none',
            stepfun: settings.voiceProviderStepFun ? {
                apiKey: settings.voiceProviderStepFun.apiKey,
            } : undefined,
        };
    }

    /**
     * Update provider configurations from settings
     */
    private updateProviderConfigs(): void {
        const config = this.getConfig();

        // Update StepFun provider
        const stepfunProvider = this.providers.get('stepfun') as StepFunASRProvider;
        if (stepfunProvider && config.stepfun?.apiKey) {
            stepfunProvider.setConfig({ apiKey: config.stepfun.apiKey });
        }

        this.currentProviderType = config.provider;
    }

    /**
     * Get the currently configured ASR provider
     */
    getProvider(): ASRProvider | null {
        this.updateProviderConfigs();

        if (this.currentProviderType === 'none') {
            return null;
        }

        const provider = this.providers.get(this.currentProviderType);
        if (!provider) {
            console.warn(`[ASRService] Provider '${this.currentProviderType}' not found`);
            return null;
        }

        if (!provider.isConfigured()) {
            console.warn(`[ASRService] Provider '${this.currentProviderType}' is not configured`);
            return null;
        }

        return provider;
    }

    /**
     * Check if ASR is available and configured
     */
    isAvailable(): boolean {
        const provider = this.getProvider();
        return provider !== null && provider.isConfigured();
    }

    /**
     * Get the current provider type
     */
    getCurrentProviderType(): ASRProviderType {
        this.updateProviderConfigs();
        return this.currentProviderType;
    }

    /**
     * Transcribe audio using the current provider
     */
    async transcribe(audio: AudioData, options?: ASROptions): Promise<ASRResult> {
        const provider = this.getProvider();

        if (!provider) {
            throw new Error('No ASR provider configured. Please configure ASR in settings.');
        }

        return provider.transcribe(audio, options);
    }

    /**
     * Get a specific provider by type (for direct access if needed)
     */
    getProviderByType(type: ASRProviderType): ASRProvider | null {
        return this.providers.get(type) || null;
    }
}

// Export singleton instance
export const ASRService = new ASRServiceClass();

// Export types for convenience
export type { ASRProvider, ASRProviderType, ASROptions, ASRResult, ASRConfig, AudioData };
