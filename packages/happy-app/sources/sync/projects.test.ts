import { describe, expect, it, vi } from 'vitest';
import { encodeBase64 } from '@/encryption/base64';
import type { AuthCredentials } from '@/auth/tokenStorage';
import { decryptProjectRecord, loadProjectAvatar } from './projects';
import type { ApiProjectRecord } from './projectTypes';

const { decryptBlobMock, downloadProjectAvatarMock } = vi.hoisted(() => ({
    decryptBlobMock: vi.fn(),
    downloadProjectAvatarMock: vi.fn(),
}));

vi.mock('@/encryption/blob', () => ({ decryptBlob: decryptBlobMock }));
vi.mock('./apiProjects', () => ({ downloadProjectAvatar: downloadProjectAvatarMock }));

function encryptedJson(value: unknown): string {
    return encodeBase64(new TextEncoder().encode(JSON.stringify(value)));
}

function record(overrides: Partial<ApiProjectRecord> = {}): ApiProjectRecord {
    return {
        id: 'project-1',
        externalId: 'external-1',
        metadata: encryptedJson({ name: 'Happy', kind: 'repository' }),
        metadataVersion: 2,
        dataEncryptionKey: 'wrapped-key',
        avatar: {
            ref: 'projects/project-1/avatar/a.enc',
            preview: encryptedJson({ thumbhash: 'thumbhash-1', mimeType: 'image/jpeg' }),
            version: 5,
        },
        createdAt: 10,
        updatedAt: 20,
        ...overrides,
    };
}

function encryptionStub(options: { key?: Uint8Array | null } = {}) {
    const key = options.key === undefined ? new Uint8Array([1, 2, 3]) : options.key;
    return {
        decryptEncryptionKey: vi.fn(async () => key),
        openEncryption: vi.fn(async () => ({
            encrypt: vi.fn(),
            decrypt: vi.fn(async (values: Uint8Array[]) => {
                const bytes = values[0];
                return [JSON.parse(new TextDecoder().decode(bytes))];
            }),
        })),
    };
}

describe('project decryption', () => {
    it('decrypts metadata and encrypted preview with the project data key', async () => {
        const encryption = encryptionStub();
        const result = await decryptProjectRecord(record(), encryption);

        expect(result?.project).toMatchObject({
            id: 'project-1',
            externalId: 'external-1',
            name: 'Happy',
            kind: 'repository',
            metadataVersion: 2,
            avatar: null,
        });
        expect(result?.avatar).toEqual({
            ref: 'projects/project-1/avatar/a.enc',
            version: 5,
            preview: { thumbhash: 'thumbhash-1', mimeType: 'image/jpeg' },
        });
        expect(encryption.decryptEncryptionKey).toHaveBeenCalledWith('wrapped-key');
        expect(encryption.openEncryption).toHaveBeenCalledTimes(2);
        expect(encryption.openEncryption).toHaveBeenNthCalledWith(1, result?.dataKey);
        expect(encryption.openEncryption).toHaveBeenNthCalledWith(2, result?.dataKey);
    });

    it('uses the legacy account encryption path when the project key is null', async () => {
        const encryption = encryptionStub({ key: null });
        const result = await decryptProjectRecord(record({ dataEncryptionKey: null }), encryption);

        expect(result?.project.name).toBe('Happy');
        expect(encryption.decryptEncryptionKey).not.toHaveBeenCalled();
        expect(encryption.openEncryption).toHaveBeenCalledWith(null);
    });
});

describe('project avatar loading', () => {
    it('downloads by project id and decrypts the blob with the derived blob key', async () => {
        const credentials: AuthCredentials = { token: 'token', secret: 'secret' };
        downloadProjectAvatarMock.mockResolvedValueOnce(new Uint8Array([1, 2]));
        decryptBlobMock.mockImplementationOnce((encrypted: Uint8Array, key: Uint8Array) => {
            expect(encrypted).toEqual(new Uint8Array([1, 2]));
            expect(key).toEqual(new Uint8Array([9, 9]));
            return new Uint8Array([255, 0]);
        });

        const result = await loadProjectAvatar(
            credentials,
            'project-1',
            {
                ref: 'projects/project-1/avatar/a.enc',
                version: 5,
                preview: { thumbhash: 'thumbhash-1', mimeType: 'image/jpeg' },
            },
            new Uint8Array([9, 9]),
        );

        expect(downloadProjectAvatarMock).toHaveBeenCalledWith(credentials, 'project-1');
        expect(result).toMatchObject({
            ref: 'projects/project-1/avatar/a.enc',
            version: 5,
            mimeType: 'image/jpeg',
            thumbhash: 'thumbhash-1',
            uri: `data:image/jpeg;base64,${encodeBase64(new Uint8Array([255, 0]))}`,
        });
    });
});