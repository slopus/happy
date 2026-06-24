import type { Session } from './storageTypes';
import type { Settings, CustomModelProvider } from './settings';
import { resolveAgentDefaultConfig } from './agentDefaults';
import type { PermissionModeKey } from '@/components/PermissionModeSelector';

export type MessageModeMeta = {
    permissionMode?: PermissionModeKey;
    model?: string | null;
    effort?: string | null;
    provider?: {
        baseUrl: string;
        apiKey: string;
        modelName: string;
    };
};

/**
 * Find a custom provider in the settings by its key.
 * The key format is "custom:{id}" — we extract the id and look it up.
 */
function findCustomProvider(modelKey: string, providers: CustomModelProvider[]): CustomModelProvider | undefined {
    const prefix = 'custom:';
    if (!modelKey.startsWith(prefix)) return undefined;
    const id = modelKey.slice(prefix.length);
    return providers.find(p => p.id === id);
}

export function resolveMessageModeMeta(
    session: Pick<Session, 'permissionMode' | 'modelMode' | 'metadata' | 'effortLevel'>,
    settings?: Pick<Settings, 'agentDefaultOverrides' | 'customModelProviders'>,
): MessageModeMeta {
    const agentDefaults = resolveAgentDefaultConfig(settings?.agentDefaultOverrides, session.metadata?.flavor);
    const meta: MessageModeMeta = {};

    // Session fields are per-session overrides. When null, use the effective
    // agent default (code default + settings-level override). The composer UI
    // displays that same effective default, so outbound metadata must include it
    // on the very first message too — otherwise a freshly-created "yolo" session
    // looks like yolo but starts Claude/Codex in default permission mode until
    // the user toggles settings and sends another turn. Delightful lie, terrible UX.
    const permissionMode = session.permissionMode ?? agentDefaults.permissionMode;
    if (permissionMode !== undefined) {
        meta.permissionMode = permissionMode;
    }

    const modelMode = session.modelMode ?? agentDefaults.modelMode;
    if (modelMode !== undefined) {
        meta.model = modelMode === 'default' ? null : modelMode;

        // If this is a custom provider, resolve the provider config and use the real model name
        if (settings?.customModelProviders) {
            const provider = findCustomProvider(modelMode, settings.customModelProviders);
            if (provider) {
                meta.model = provider.modelName;
                meta.provider = {
                    baseUrl: provider.baseUrl,
                    apiKey: provider.apiKey,
                    modelName: provider.modelName,
                };
            }
        }
    }

    const effort = session.effortLevel ?? agentDefaults.effortLevel;
    if (effort !== undefined) {
        meta.effort = effort;
    }

    return meta;
}
