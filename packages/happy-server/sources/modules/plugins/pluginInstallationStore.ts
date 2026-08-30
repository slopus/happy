import { z } from 'zod';
import { PluginPermissionListSchema, type PluginPermission } from '@slopus/happy-wire';

import { decryptString, encryptString } from '@/modules/encrypt';
import { db } from '@/storage/db';

export interface PluginInstallation {
    version: string;
    grantedPermissions: PluginPermission[];
    configuration: Record<string, string>;
}

export interface PluginInstallationRepository {
    find: (accountId: string, storageKey: string) => Promise<Uint8Array<ArrayBuffer> | null>;
    upsert: (accountId: string, storageKey: string, encrypted: Uint8Array<ArrayBuffer>) => Promise<void>;
    delete: (accountId: string, storageKey: string) => Promise<void>;
}

interface PluginInstallationStoreDependencies {
    repository: PluginInstallationRepository;
    encrypt: (path: string[], value: string) => Uint8Array<ArrayBuffer>;
    decrypt: (path: string[], encrypted: Uint8Array<ArrayBuffer>) => string;
}

interface ServiceAccountTokenStore {
    serviceAccountToken: {
        findUnique: (args: unknown) => Promise<{ token: Uint8Array<ArrayBuffer> } | null>;
        upsert: (args: unknown) => Promise<unknown>;
        deleteMany: (args: unknown) => Promise<unknown>;
    };
}

const installationSchema = z.object({
    version: z.string().min(1).max(50),
    grantedPermissions: PluginPermissionListSchema.default([]),
    configuration: z.record(z.string(), z.string()),
}).strict();

function storageKey(pluginId: string): string {
    return `plugin:${pluginId}`;
}

function encryptionPath(accountId: string, pluginId: string): string[] {
    return ['user', accountId, 'plugins', pluginId, 'installation'];
}

function legacyEncryptionPath(accountId: string, pluginId: string): string[] {
    return ['user', accountId, 'plugins', pluginId, 'secret'];
}

function parseLegacyInstallation(value: string): PluginInstallation {
    const parsed = z.record(z.string(), z.unknown()).parse(JSON.parse(value));
    if (parsed.version === 1 && Object.keys(parsed).length === 1) {
        return { version: '1.0.0', grantedPermissions: [], configuration: {} };
    }
    return {
        version: '1.0.0',
        grantedPermissions: [],
        configuration: z.record(z.string(), z.string()).parse(parsed),
    };
}

export function createPluginInstallationStore(dependencies: PluginInstallationStoreDependencies) {
    return {
        async set(accountId: string, pluginId: string, installation: PluginInstallation): Promise<void> {
            const validated = installationSchema.parse(installation);
            const encrypted = dependencies.encrypt(
                encryptionPath(accountId, pluginId),
                JSON.stringify(validated),
            );
            await dependencies.repository.upsert(accountId, storageKey(pluginId), encrypted);
        },
        async get(accountId: string, pluginId: string): Promise<PluginInstallation | null> {
            const encrypted = await dependencies.repository.find(accountId, storageKey(pluginId));
            if (!encrypted) return null;
            try {
                const value = dependencies.decrypt(encryptionPath(accountId, pluginId), encrypted);
                return installationSchema.parse(JSON.parse(value));
            } catch (error) {
                try {
                    const legacy = dependencies.decrypt(legacyEncryptionPath(accountId, pluginId), encrypted);
                    return parseLegacyInstallation(legacy);
                } catch {
                    throw error;
                }
            }
        },
        async delete(accountId: string, pluginId: string): Promise<void> {
            await dependencies.repository.delete(accountId, storageKey(pluginId));
        },
    };
}

export function createServiceAccountTokenPluginInstallationRepository(
    database: ServiceAccountTokenStore,
): PluginInstallationRepository {
    return {
        async find(accountId, key) {
            const record = await database.serviceAccountToken.findUnique({
                where: { accountId_vendor: { accountId, vendor: key } },
                select: { token: true },
            });
            return record?.token ?? null;
        },
        async upsert(accountId, key, encrypted) {
            await database.serviceAccountToken.upsert({
                where: { accountId_vendor: { accountId, vendor: key } },
                update: { token: encrypted },
                create: { accountId, vendor: key, token: encrypted },
            });
        },
        async delete(accountId, key) {
            await database.serviceAccountToken.deleteMany({ where: { accountId, vendor: key } });
        },
    };
}

export const pluginInstallationStore = createPluginInstallationStore({
    repository: createServiceAccountTokenPluginInstallationRepository(
        db as unknown as ServiceAccountTokenStore,
    ),
    encrypt: encryptString,
    decrypt: decryptString,
});
