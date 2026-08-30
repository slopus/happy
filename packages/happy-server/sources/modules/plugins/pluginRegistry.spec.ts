import { describe, expect, it, vi } from 'vitest';
import type { PluginPermission } from '@slopus/happy-wire';

import { pluginDefinitions } from '@/modules/plugins/pluginDefinitions';
import type { PluginInstallation } from '@/modules/plugins/pluginInstallationStore';
import { createPluginRegistry, PluginRegistryError } from '@/modules/plugins/pluginRegistry';

function createMemoryStore() {
    const installations = new Map<string, PluginInstallation>();
    return {
        installations,
        store: {
            get: vi.fn(async (accountId: string, pluginId: string) => installations.get(`${accountId}:${pluginId}`) ?? null),
            set: vi.fn(async (accountId: string, pluginId: string, value: PluginInstallation) => {
                installations.set(`${accountId}:${pluginId}`, value);
            }),
            delete: vi.fn(async (accountId: string, pluginId: string) => {
                installations.delete(`${accountId}:${pluginId}`);
            }),
        },
    };
}

function grants(pluginId: string): PluginPermission[] {
    const definition = pluginDefinitions.find(({ manifest }) => manifest.id === pluginId);
    if (!definition) throw new Error(`Missing plugin definition: ${pluginId}`);
    return [...definition.manifest.permissions];
}

describe('createPluginRegistry', () => {
    it('lists server-owned manifests with account-specific installation status', async () => {
        const { store } = createMemoryStore();
        const registry = createPluginRegistry(pluginDefinitions, store);

        const catalog = await registry.list('user-1');

        expect(catalog.plugins.map((item) => item.manifest.id)).toEqual([
            'relationship-advisor',
            'generated-images-gallery',
        ]);
        expect(catalog.plugins.every((item) => !item.status.installed)).toBe(true);
    });

    it('pins the requested manifest version, normalizes configuration, and redacts secrets', async () => {
        const { store } = createMemoryStore();
        const registry = createPluginRegistry(pluginDefinitions, store);

        const status = await registry.install('user-1', 'relationship-advisor', {
            version: '1.1.1',
            grantedPermissions: grants('relationship-advisor'),
            configuration: {
                apiKey: '  sk-secret-1234  ',
                baseUrl: 'https://api.example.com/v1/',
                model: ' example-chat ',
            },
        });

        expect(status).toEqual({
            installed: true,
            version: '1.1.1',
            grantedPermissions: grants('relationship-advisor'),
            configuration: {
                baseUrl: 'https://api.example.com/v1',
                model: 'example-chat',
            },
            secretHints: { apiKey: '1234' },
        });
        expect(JSON.stringify(status)).not.toContain('sk-secret');
        store.get.mockClear();
        await expect(registry.openRuntime('user-1', 'relationship-advisor', [
            'paws.ai.provider.invoke',
            'paws.secrets.use',
        ])).resolves.toEqual({
            apiKey: 'sk-secret-1234',
            baseUrl: 'https://api.example.com/v1',
            model: 'example-chat',
        });
        expect(store.get).toHaveBeenCalledTimes(1);

        const updated = await registry.install('user-1', 'relationship-advisor', {
            version: '1.1.1',
            grantedPermissions: grants('relationship-advisor'),
            configuration: {
                apiKey: '',
                baseUrl: 'https://api.example.com/v2',
                model: 'new-model',
            },
        });
        expect(updated).toMatchObject({ secretHints: { apiKey: '1234' } });
        await expect(registry.openRuntime('user-1', 'relationship-advisor', [
            'paws.ai.provider.invoke',
            'paws.secrets.use',
        ]))
            .resolves.toMatchObject({ apiKey: 'sk-secret-1234', model: 'new-model' });
    });

    it('tests merged configuration without saving it', async () => {
        const { store } = createMemoryStore();
        const testConnection = vi.fn(async () => ({ success: true as const, latencyMs: 12 }));
        const relationshipDefinition = pluginDefinitions.find(({ manifest }) => manifest.id === 'relationship-advisor');
        if (!relationshipDefinition) throw new Error('relationship-advisor definition missing');
        const registry = createPluginRegistry([{
            ...relationshipDefinition,
            testConnection,
        }], store);
        await registry.install('user-1', 'relationship-advisor', {
            version: '1.1.1',
            grantedPermissions: grants('relationship-advisor'),
            configuration: {
                apiKey: 'stored-secret',
                baseUrl: 'https://api.example.com/v1',
                model: 'old-model',
            },
        });
        store.set.mockClear();

        const registryWithTest = registry as typeof registry & {
            testConnection?: (
                accountId: string,
                pluginId: string,
                request: {
                    version: string;
                    grantedPermissions: PluginPermission[];
                    configuration: Record<string, string>;
                },
            ) => Promise<{ success: boolean; latencyMs?: number }>;
        };
        expect(registryWithTest.testConnection).toBeTypeOf('function');
        if (!registryWithTest.testConnection) return;

        await expect(registryWithTest.testConnection('user-1', 'relationship-advisor', {
            version: '1.1.1',
            grantedPermissions: grants('relationship-advisor'),
            configuration: {
                apiKey: '',
                baseUrl: 'https://api.example.com/v1',
                model: 'new-model',
            },
        })).resolves.toEqual({ success: true, latencyMs: 12 });
        expect(testConnection).toHaveBeenCalledWith({
            apiKey: 'stored-secret',
            baseUrl: 'https://api.example.com/v1',
            model: 'new-model',
        });
        expect(store.set).not.toHaveBeenCalled();
    });

    it('requires the secret again when a provider URL changes origin', async () => {
        const { store } = createMemoryStore();
        const testConnection = vi.fn(async () => ({ success: true as const, latencyMs: 12 }));
        const relationshipDefinition = pluginDefinitions.find(({ manifest }) => manifest.id === 'relationship-advisor');
        if (!relationshipDefinition) throw new Error('relationship-advisor definition missing');
        const registry = createPluginRegistry([{
            ...relationshipDefinition,
            testConnection,
        }], store);
        await registry.install('user-1', 'relationship-advisor', {
            version: '1.1.1',
            grantedPermissions: grants('relationship-advisor'),
            configuration: {
                apiKey: 'stored-secret',
                baseUrl: 'https://api.example.com/v1',
                model: 'old-model',
            },
        });

        const changedOrigin = {
            version: '1.1.1',
            grantedPermissions: grants('relationship-advisor'),
            configuration: {
                apiKey: '',
                baseUrl: 'https://attacker.example/v1',
                model: 'new-model',
            },
        };
        await expect(registry.testConnection('user-1', 'relationship-advisor', changedOrigin))
            .rejects.toMatchObject({ code: 'invalid_configuration' });
        await expect(registry.install('user-1', 'relationship-advisor', changedOrigin))
            .rejects.toMatchObject({ code: 'invalid_configuration' });
        expect(testConnection).not.toHaveBeenCalled();
        await expect(registry.openRuntime('user-1', 'relationship-advisor', [
            'paws.ai.provider.invoke',
            'paws.secrets.use',
        ])).resolves.toEqual({
            apiKey: 'stored-secret',
            baseUrl: 'https://api.example.com/v1',
            model: 'old-model',
        });
    });

    it('rejects unknown plugins, stale versions, and arbitrary configuration fields', async () => {
        const { store } = createMemoryStore();
        const registry = createPluginRegistry(pluginDefinitions, store);

        await expect(registry.install('user-1', 'missing-plugin', {
            version: '1.1.0', grantedPermissions: [], configuration: {},
        })).rejects.toMatchObject({ code: 'plugin_not_found' } satisfies Partial<PluginRegistryError>);
        await expect(registry.install('user-1', 'relationship-advisor', {
            version: '0.9.0', grantedPermissions: grants('relationship-advisor'), configuration: {},
        })).rejects.toMatchObject({ code: 'version_mismatch' } satisfies Partial<PluginRegistryError>);
        await expect(registry.install('user-1', 'generated-images-gallery', {
            version: '1.1.1',
            grantedPermissions: grants('generated-images-gallery'),
            configuration: { source: 'javascript:alert(1)' },
        })).rejects.toMatchObject({ code: 'invalid_configuration' } satisfies Partial<PluginRegistryError>);
        await expect(registry.install('user-1', 'relationship-advisor', {
            version: '1.1.1',
            grantedPermissions: ['paws.ai.provider.invoke'],
            configuration: {
                apiKey: 'sk-secret',
                baseUrl: 'https://api.example.com/v1',
                model: 'example-chat',
            },
        })).rejects.toMatchObject({ code: 'invalid_permission_grant' } satisfies Partial<PluginRegistryError>);
    });

    it('uninstalls idempotently and blocks runtime configuration after removal', async () => {
        const { store } = createMemoryStore();
        const registry = createPluginRegistry(pluginDefinitions, store);
        await registry.install('user-2', 'generated-images-gallery', {
            version: '1.1.1',
            grantedPermissions: grants('generated-images-gallery'),
            configuration: {},
        });

        await expect(registry.uninstall('user-2', 'generated-images-gallery')).resolves.toEqual({ installed: false });
        await expect(registry.uninstall('user-2', 'generated-images-gallery')).resolves.toEqual({ installed: false });
        await expect(registry.openRuntime('user-2', 'generated-images-gallery', []))
            .rejects.toMatchObject({ code: 'plugin_not_installed' });
    });

    it('blocks stale installed versions from runtime execution until they are updated', async () => {
        const { installations, store } = createMemoryStore();
        installations.set('user-stale:relationship-advisor', {
            version: '0.9.0',
            grantedPermissions: grants('relationship-advisor'),
            configuration: {
                apiKey: 'stale-secret',
                baseUrl: 'https://api.example.com/v1',
                model: 'old-model',
            },
        });
        const registry = createPluginRegistry(pluginDefinitions, store);

        await expect(registry.openRuntime('user-stale', 'relationship-advisor', [
            'paws.ai.provider.invoke',
        ]))
            .rejects.toMatchObject({ code: 'version_mismatch' });
    });

    it('authorizes only installed plugins that declared the requested host capability', async () => {
        const { store } = createMemoryStore();
        const registry = createPluginRegistry(pluginDefinitions, store);
        await registry.install('user-1', 'relationship-advisor', {
            version: '1.1.1',
            grantedPermissions: grants('relationship-advisor'),
            configuration: {
                apiKey: 'sk-secret',
                baseUrl: 'https://api.example.com/v1',
                model: 'example-chat',
            },
        });
        await registry.install('user-1', 'generated-images-gallery', {
            version: '1.1.1',
            grantedPermissions: grants('generated-images-gallery'),
            configuration: {},
        });

        await expect(registry.openRuntime(
            'user-1',
            'relationship-advisor',
            ['paws.ai.provider.invoke'],
        )).resolves.toMatchObject({ apiKey: 'sk-secret' });
        await expect(registry.openRuntime(
            'user-1',
            'generated-images-gallery',
            ['paws.ai.provider.invoke'],
        )).rejects.toMatchObject({ code: 'permission_not_declared' });
        await expect(registry.openRuntime(
            'user-2',
            'relationship-advisor',
            ['paws.ai.provider.invoke'],
        )).rejects.toMatchObject({ code: 'plugin_not_installed' });
    });

    it('fails closed when an existing installation has not granted a declared permission', async () => {
        const { installations, store } = createMemoryStore();
        installations.set('user-before-grants:relationship-advisor', {
            version: '1.1.1',
            grantedPermissions: [],
            configuration: {
                apiKey: 'stored-secret',
                baseUrl: 'https://api.example.com/v1',
                model: 'example-chat',
            },
        });
        const registry = createPluginRegistry(pluginDefinitions, store);

        await expect(registry.openRuntime('user-before-grants', 'relationship-advisor', [
            'paws.ai.provider.invoke',
        ])).rejects.toMatchObject({ code: 'permission_not_granted' });
    });

    it('blocks every runtime capability when the stored grant snapshot is only a subset', async () => {
        const { installations, store } = createMemoryStore();
        installations.set('user-partial-grants:relationship-advisor', {
            version: '1.1.1',
            grantedPermissions: ['paws.storage.images.write'],
            configuration: {
                apiKey: 'stored-secret',
                baseUrl: 'https://api.example.com/v1',
                model: 'example-chat',
            },
        });
        const registry = createPluginRegistry(pluginDefinitions, store);

        await expect(registry.openRuntime('user-partial-grants', 'relationship-advisor', [
            'paws.storage.images.write',
        ])).rejects.toMatchObject({ code: 'permission_not_granted' });
    });
});
