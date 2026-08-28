import type {
    PluginCatalogItem,
    PluginCatalogResponse,
    PluginInstallRequest,
    PluginInstallationStatus,
    PluginPermission,
} from '@slopus/happy-wire';

import type { PluginDefinition } from '@/modules/plugins/pluginDefinitions';
import { pluginDefinitions } from '@/modules/plugins/pluginDefinitions';
import type { PluginInstallation } from '@/modules/plugins/pluginInstallationStore';
import { pluginInstallationStore } from '@/modules/plugins/pluginInstallationStore';

interface PluginInstallationStore {
    get: (accountId: string, pluginId: string) => Promise<PluginInstallation | null>;
    set: (accountId: string, pluginId: string, value: PluginInstallation) => Promise<void>;
    delete: (accountId: string, pluginId: string) => Promise<void>;
}

export type PluginRegistryErrorCode =
    | 'plugin_not_found'
    | 'plugin_not_installed'
    | 'version_mismatch'
    | 'permission_not_declared'
    | 'invalid_configuration';

export class PluginRegistryError extends Error {
    constructor(public readonly code: PluginRegistryErrorCode, message: string) {
        super(message);
        this.name = 'PluginRegistryError';
    }
}

function findDefinition(definitions: readonly PluginDefinition[], pluginId: string): PluginDefinition {
    const definition = definitions.find((candidate) => candidate.manifest.id === pluginId);
    if (!definition) throw new PluginRegistryError('plugin_not_found', `Unknown plugin: ${pluginId}`);
    return definition;
}

function publicStatus(definition: PluginDefinition, installation: PluginInstallation | null): PluginInstallationStatus {
    if (!installation) return { installed: false };
    const status = definition.redactConfiguration(installation.configuration);
    return { ...status, version: installation.version };
}

export function createPluginRegistry(
    definitions: readonly PluginDefinition[],
    store: PluginInstallationStore,
) {
    async function get(accountId: string, pluginId: string): Promise<PluginCatalogItem> {
        const definition = findDefinition(definitions, pluginId);
        const installation = await store.get(accountId, pluginId);
        return { manifest: definition.manifest, status: publicStatus(definition, installation) };
    }

    async function requireCurrentInstallation(accountId: string, pluginId: string): Promise<{
        definition: PluginDefinition;
        installation: PluginInstallation;
    }> {
        const definition = findDefinition(definitions, pluginId);
        const installation = await store.get(accountId, pluginId);
        if (!installation) {
            throw new PluginRegistryError('plugin_not_installed', `Plugin ${pluginId} is not installed`);
        }
        if (installation.version !== definition.manifest.version) {
            throw new PluginRegistryError(
                'version_mismatch',
                `Plugin ${pluginId} requires version ${definition.manifest.version}`,
            );
        }
        return { definition, installation };
    }

    return {
        async list(accountId: string): Promise<PluginCatalogResponse> {
            return {
                plugins: await Promise.all(definitions.map(async (definition) => ({
                    manifest: definition.manifest,
                    status: publicStatus(
                        definition,
                        await store.get(accountId, definition.manifest.id),
                    ),
                }))),
            };
        },
        get,
        async install(
            accountId: string,
            pluginId: string,
            request: PluginInstallRequest,
        ): Promise<PluginInstallationStatus> {
            const definition = findDefinition(definitions, pluginId);
            if (request.version !== definition.manifest.version) {
                throw new PluginRegistryError(
                    'version_mismatch',
                    `Plugin ${pluginId} requires version ${definition.manifest.version}`,
                );
            }
            let configuration: Record<string, string>;
            try {
                const previous = await store.get(accountId, pluginId);
                const merged = { ...request.configuration };
                for (const field of definition.manifest.configuration.fields) {
                    if (field.type !== 'secret') continue;
                    if (merged[field.key]?.trim()) continue;
                    if (previous?.configuration[field.key]) {
                        merged[field.key] = previous.configuration[field.key];
                    }
                }
                configuration = definition.normalizeConfiguration(merged);
            } catch {
                throw new PluginRegistryError('invalid_configuration', `Invalid configuration for ${pluginId}`);
            }
            const installation = { version: definition.manifest.version, configuration };
            await store.set(accountId, pluginId, installation);
            return publicStatus(definition, installation);
        },
        async uninstall(accountId: string, pluginId: string): Promise<PluginInstallationStatus> {
            findDefinition(definitions, pluginId);
            await store.delete(accountId, pluginId);
            return { installed: false };
        },
        async requirePermission(
            accountId: string,
            pluginId: string,
            permission: PluginPermission,
        ): Promise<void> {
            const { definition } = await requireCurrentInstallation(accountId, pluginId);
            if (!definition.manifest.permissions.includes(permission)) {
                throw new PluginRegistryError(
                    'permission_not_declared',
                    `Plugin ${pluginId} did not declare permission ${permission}`,
                );
            }
        },
        async requireConfiguration(accountId: string, pluginId: string): Promise<Record<string, string>> {
            const { definition, installation } = await requireCurrentInstallation(accountId, pluginId);
            try {
                return definition.normalizeConfiguration(installation.configuration);
            } catch {
                throw new PluginRegistryError('invalid_configuration', `Invalid configuration for ${pluginId}`);
            }
        },
    };
}

export const pluginRegistry = createPluginRegistry(pluginDefinitions, pluginInstallationStore);
