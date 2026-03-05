/**
 * Cloud Provider Registry
 *
 * Maps agent types and profiles to the correct CloudProvider + config.
 * Handles extracting API keys from the existing profile system.
 */

import type { AIBackendProfile } from '@/sync/settings';
import type { CloudProvider, CloudProviderConfig } from './types';
import { AnthropicCloudProvider } from './providers/anthropic';
import { OpenAICloudProvider } from './providers/openai';
import { GeminiCloudProvider } from './providers/gemini';

/** Agent types supported in cloud mode */
export type CloudAgentType = 'claude' | 'codex' | 'openclaw' | 'gemini';

/** Map of provider ID to provider instance */
const providers: Record<string, CloudProvider> = {
    anthropic: AnthropicCloudProvider,
    openai: OpenAICloudProvider,
    gemini: GeminiCloudProvider,
};

/** Map agent type to the cloud provider it should use */
const agentToProvider: Record<CloudAgentType, string> = {
    claude: 'anthropic',
    openclaw: 'anthropic', // OpenClaw uses Anthropic model in cloud mode
    codex: 'openai',
    gemini: 'gemini',
};

/**
 * Get the CloudProvider for a given agent type.
 */
export function getCloudProvider(agentType: CloudAgentType): CloudProvider {
    const providerId = agentToProvider[agentType];
    return providers[providerId];
}

/**
 * Get the provider ID for a given agent type (e.g., 'anthropic', 'openai', 'gemini').
 */
export function getCloudProviderId(agentType: CloudAgentType): 'anthropic' | 'openai' | 'gemini' {
    return agentToProvider[agentType] as 'anthropic' | 'openai' | 'gemini';
}

/**
 * Check if a string is a variable template (e.g., "${VAR}" or "${VAR:-default}").
 * Cloud mode cannot use template variables — those require a daemon to expand.
 */
function isTemplateVar(value: string | undefined): boolean {
    if (!value) return false;
    return /^\$\{[A-Z_][A-Z0-9_]*(:-[^}]*)?\}$/.test(value);
}

/**
 * Extract CloudProviderConfig from a profile for a given agent type.
 * Returns null if the profile doesn't have a usable API key for cloud mode.
 */
export function getCloudConfigFromProfile(
    profile: AIBackendProfile,
    agentType: CloudAgentType,
): CloudProviderConfig | null {
    const providerId = agentToProvider[agentType];

    switch (providerId) {
        case 'anthropic': {
            const cfg = profile.anthropicConfig;
            if (!cfg?.authToken || isTemplateVar(cfg.authToken)) return null;
            return {
                apiKey: cfg.authToken,
                baseUrl: isTemplateVar(cfg.baseUrl) ? undefined : cfg.baseUrl,
                model: cfg.model,
            };
        }
        case 'openai': {
            const cfg = profile.openaiConfig;
            if (!cfg?.apiKey || isTemplateVar(cfg.apiKey)) return null;
            return {
                apiKey: cfg.apiKey,
                baseUrl: isTemplateVar(cfg.baseUrl) ? undefined : cfg.baseUrl,
                model: cfg.model,
            };
        }
        case 'gemini': {
            // Check geminiConfig first, fall back to environment variables
            const geminiCfg = profile.geminiConfig;
            if (geminiCfg?.apiKey && !isTemplateVar(geminiCfg.apiKey)) {
                return {
                    apiKey: geminiCfg.apiKey,
                    baseUrl: isTemplateVar(geminiCfg.baseUrl) ? undefined : geminiCfg.baseUrl,
                    model: geminiCfg.model,
                };
            }

            // Look for GEMINI_API_KEY in environment variables
            const envKey = profile.environmentVariables.find(
                (v) => v.name === 'GEMINI_API_KEY' || v.name === 'GOOGLE_API_KEY'
            );
            if (envKey && !isTemplateVar(envKey.value)) {
                return {
                    apiKey: envKey.value,
                };
            }
            return null;
        }
        default:
            return null;
    }
}

/**
 * Check if a profile is capable of cloud chat for a given agent type.
 * A profile is cloud-capable if it has a literal (non-template) API key.
 */
export function isProfileCloudCapable(
    profile: AIBackendProfile,
    agentType: CloudAgentType,
): boolean {
    return getCloudConfigFromProfile(profile, agentType) !== null;
}
