import { describe, expect, it, vi } from 'vitest';

import { createPluginInstallationStore } from '@/modules/plugins/pluginInstallationStore';

describe('createPluginInstallationStore', () => {
    it('encrypts the complete versioned installation document before persistence', async () => {
        const upsert = vi.fn(async () => undefined);
        const encrypt = vi.fn(() => new Uint8Array([7, 8, 9]));
        const store = createPluginInstallationStore({
            repository: {
                find: vi.fn(async () => null),
                upsert,
                delete: vi.fn(async () => undefined),
            },
            encrypt,
            decrypt: vi.fn(),
        });

        await store.set('user-1', 'relationship-advisor', {
            version: '1.0.0',
            configuration: { apiKey: 'sk-secret', model: 'chat' },
        });

        expect(encrypt).toHaveBeenCalledWith(
            ['user', 'user-1', 'plugins', 'relationship-advisor', 'installation'],
            JSON.stringify({
                version: '1.0.0',
                configuration: { apiKey: 'sk-secret', model: 'chat' },
            }),
        );
        expect(upsert).toHaveBeenCalledWith(
            'user-1',
            'plugin:relationship-advisor',
            new Uint8Array([7, 8, 9]),
        );
    });

    it('decrypts and validates an existing installation', async () => {
        const encrypted = new Uint8Array([3, 2, 1]);
        const decrypt = vi.fn(() => JSON.stringify({
            version: '1.0.0',
            configuration: { apiKey: 'stored-secret' },
        }));
        const store = createPluginInstallationStore({
            repository: {
                find: vi.fn(async () => encrypted),
                upsert: vi.fn(async () => undefined),
                delete: vi.fn(async () => undefined),
            },
            encrypt: vi.fn(),
            decrypt,
        });

        await expect(store.get('user-2', 'relationship-advisor')).resolves.toEqual({
            version: '1.0.0',
            configuration: { apiKey: 'stored-secret' },
        });
        expect(decrypt).toHaveBeenCalledWith(
            ['user', 'user-2', 'plugins', 'relationship-advisor', 'installation'],
            encrypted,
        );
    });

    it('reads records written by the previous secret-vault format during upgrade', async () => {
        const encrypted = new Uint8Array([4, 5, 6]);
        const decrypt = vi.fn()
            .mockImplementationOnce(() => { throw new Error('wrong associated path'); })
            .mockReturnValueOnce(JSON.stringify({
                apiKey: 'legacy-secret',
                baseUrl: 'https://api.example.com/v1',
                model: 'legacy-model',
            }));
        const store = createPluginInstallationStore({
            repository: {
                find: vi.fn(async () => encrypted),
                upsert: vi.fn(async () => undefined),
                delete: vi.fn(async () => undefined),
            },
            encrypt: vi.fn(),
            decrypt,
        });

        await expect(store.get('user-legacy', 'relationship-advisor')).resolves.toEqual({
            version: '1.0.0',
            configuration: {
                apiKey: 'legacy-secret',
                baseUrl: 'https://api.example.com/v1',
                model: 'legacy-model',
            },
        });
        expect(decrypt).toHaveBeenNthCalledWith(
            2,
            ['user', 'user-legacy', 'plugins', 'relationship-advisor', 'secret'],
            encrypted,
        );
    });
});
