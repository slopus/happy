import type {
    PluginCatalogItem,
    PluginCatalogResponse,
    PluginConnectionTestResult,
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
    | 'invalid_permission_grant'
    | 'permission_not_declared'
    | 'permission_not_granted'
    | 'connection_test_unsupported'
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
    return {
        installed: true,
        version: installation.version,
        grantedPermissions: installation.grantedPermissions,
        ...status,
    };
}

export function createPluginRegistry(
    definitions: readonly PluginDefinition[],
    store: PluginInstallationStore,
) {
    function canReuseStoredSecrets(
        definition: PluginDefinition,
        previous: PluginInstallation | null,
        requested: Record<string, string>,
    ): boolean {
        if (!previous) return false;
        return definition.manifest.configuration.fields
            .filter((field) => field.type === 'url')
            .every((field) => {
                try {
                    return new URL(previous.configuration[field.key] ?? '').origin
                        === new URL(requested[field.key] ?? '').origin;
                } catch {
                    return false;
                }
            });
    }

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

    async function resolveRequestedConfiguration(
        accountId: string,
        definition: PluginDefinition,
        request: PluginInstallRequest,
    ): Promise<Record<string, string>> {
        if (request.version !== definition.manifest.version) {
            throw new PluginRegistryError(
                'version_mismatch',
                `Plugin ${definition.manifest.id} requires version ${definition.manifest.version}`,
            );
        }
        const declaredPermissions = definition.manifest.permissions;
        if (
            request.grantedPermissions.length !== declaredPermissions.length
            || declaredPermissions.some((permission) => !request.grantedPermissions.includes(permission))
        ) {
            throw new PluginRegistryError(
                'invalid_permission_grant',
                `Plugin ${definition.manifest.id} requires its declared permission set`,
            );
        }
        try {
            const previous = await store.get(accountId, definition.manifest.id);
            const merged = { ...request.configuration };
            const reuseStoredSecrets = canReuseStoredSecrets(definition, previous, merged);
            for (const field of definition.manifest.configuration.fields) {
                if (field.type !== 'secret') continue;
                if (merged[field.key]?.trim()) continue;
                if (reuseStoredSecrets && previous?.configuration[field.key]) {
                    merged[field.key] = previous.configuration[field.key];
                }
            }
            return definition.normalizeConfiguration(merged);
        } catch (error) {
            if (error instanceof PluginRegistryError) throw error;
            throw new PluginRegistryError(
                'invalid_configuration',
                `Invalid configuration for ${definition.manifest.id}`,
            );
        }
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
            const configuration = await resolveRequestedConfiguration(accountId, definition, request);
            const installation = {
                version: definition.manifest.version,
                grantedPermissions: [...definition.manifest.permissions],
                configuration,
            };
            await store.set(accountId, pluginId, installation);
            return publicStatus(definition, installation);
        },
        async testConnection(
            accountId: string,
            pluginId: string,
            request: PluginInstallRequest,
        ): Promise<PluginConnectionTestResult> {
            const definition = findDefinition(definitions, pluginId);
            if (!definition.testConnection) {
                throw new PluginRegistryError(
                    'connection_test_unsupported',
                    `Plugin ${pluginId} does not support connection testing`,
                );
            }
            return definition.testConnection(
                await resolveRequestedConfiguration(accountId, definition, request),
            );
        },
        async uninstall(accountId: string, pluginId: string): Promise<PluginInstallationStatus> {
            findDefinition(definitions, pluginId);
            await store.delete(accountId, pluginId);
            return { installed: false };
        },
        async openRuntime(
            accountId: string,
            pluginId: string,
            requiredPermissions: readonly PluginPermission[],
        ): Promise<Record<string, string>> {
            const { definition, installation } = await requireCurrentInstallation(accountId, pluginId);
            const declaredPermissions = definition.manifest.permissions;
            if (
                installation.grantedPermissions.length !== declaredPermissions.length
                || declaredPermissions.some((permission) => !installation.grantedPermissions.includes(permission))
            ) {
                throw new PluginRegistryError(
                    'permission_not_granted',
                    `Plugin ${pluginId} must review and grant its current permission set`,
                );
            }
            for (const permission of requiredPermissions) {
                if (!declaredPermissions.includes(permission)) {
                    throw new PluginRegistryError(
                        'permission_not_declared',
                        `Plugin ${pluginId} did not declare permission ${permission}`,
                    );
                }
                if (!installation.grantedPermissions.includes(permission)) {
                    throw new PluginRegistryError(
                        'permission_not_granted',
                        `Plugin ${pluginId} was not granted permission ${permission}`,
                    );
                }
            }
            try {
                return definition.normalizeConfiguration(installation.configuration);
            } catch {
                throw new PluginRegistryError('invalid_configuration', `Invalid configuration for ${pluginId}`);
            }
        },
    };
}

export const pluginRegistry = createPluginRegistry(pluginDefinitions, pluginInstallationStore);
